/** 개념 이미지 사전생성 - 수동 실행 전용 (실비용).
 *   npm run concept-images                                    # 없는 것만 전부
 *   npm run concept-images -- --only trigonometric-ratio
 *   npm run concept-images -- --upload   # 검수 확정본 업로드 + 메타 upsert
 * 생성물은 tools/concept-images/img/<id>.png - 눈으로 검수 후 --upload 로
 * Storage/DB 에 반영한다. 이미 있는 파일은 건너뛴다(재실행 안전).
 * 앱 코드 의존은 순수 모듈 2개뿐 - RN import 가 섞이면 ts-node 가 죽는다. */
import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import { CONCEPT_LIST } from './conceptList';
import { conceptBoardPrompt } from '../../src/prompts/conceptBoardPrompt';

// .env 수동 로드 - tools/export_chat_history.ts 와 동일 관례(이 저장소의
// ts-node 스크립트는 `-r dotenv/config` 대신 이렇게 로드한다).
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  for (const line of envConfig.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const val = valueParts.join('=').trim();
      if (key && val) {
        process.env[key.trim()] = val;
      }
    }
  }
}

const OUT_DIR = path.join(__dirname, 'img');

/** 검수 끝난 img/ 의 PNG 를 Storage 에 올리고 전 개념 메타를 upsert 한다.
 * service role 키 사용(RLS 우회) - 버킷/테이블에 anon 쓰기 정책이 없다.
 * PNG 없는 개념은 image_path=null 로 메타만 - 앱이 이미지 없는 행을 등록
 * 목록에서 제외해 생성 경로로 폴백한다. */
async function upload() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('EXPO_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요 (.env)');
  }
  const sb = createClient(url, serviceKey);
  for (const c of CONCEPT_LIST) {
    const file = path.join(OUT_DIR, `${c.id}.png`);
    const hasImage = fs.existsSync(file);
    if (hasImage) {
      const { error } = await sb.storage
        .from('concept-images')
        .upload(`${c.id}.png`, fs.readFileSync(file), { contentType: 'image/png', upsert: true });
      if (error) throw new Error(`${c.id} 업로드 실패: ${error.message}`);
    }
    const { error: dbErr } = await sb.from('concepts').upsert({
      id: c.id,
      name: c.name,
      aliases: c.aliases,
      sketch: c.sketch,
      image_path: hasImage ? `${c.id}.png` : null,
    });
    if (dbErr) throw new Error(`${c.id} upsert 실패: ${dbErr.message}`);
    console.log(`upload: ${c.id}${hasImage ? '' : ' (이미지 없음 - 메타만)'}`);
  }
  console.log(`\n완료: ${CONCEPT_LIST.length}개 개념 동기화`);
}

async function main() {
  if (process.argv.includes('--upload')) {
    await upload();
    return;
  }
  const apiKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
  const modelId = process.env.EXPO_PUBLIC_GEMINI_IMAGE_MODEL_ID || 'gemini-3.1-flash-image';
  if (!apiKey) throw new Error('EXPO_PUBLIC_GEMINI_API_KEY 필요 (.env)');
  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1]
    : null;
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelId,
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '16:9' },
    } as any,
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const targets = CONCEPT_LIST.filter((c) => (only ? c.id === only : true));
  if (only && targets.length === 0) throw new Error(`unknown id: ${only}`);
  for (const c of targets) {
    const out = path.join(OUT_DIR, `${c.id}.png`);
    if (fs.existsSync(out)) {
      console.log(`skip (exists): ${c.id}`);
      continue;
    }
    console.log(`generate: ${c.id} (${c.name})`);
    const result = await model.generateContent([{ text: conceptBoardPrompt(c.name, c.sketch) }]);
    const part = result.response.candidates?.[0]?.content?.parts?.find(
      (p: { inlineData?: { mimeType?: string; data?: string } }) =>
        p.inlineData?.mimeType?.startsWith('image/') && p.inlineData?.data,
    );
    if (!part?.inlineData?.data) {
      console.error(`  FAILED (no image part): ${c.id} - 건너뜀, 재실행으로 재시도`);
      continue;
    }
    fs.writeFileSync(out, Buffer.from(part.inlineData.data, 'base64'));
    console.log(`  saved: ${out} (${Math.round(part.inlineData.data.length / 1365)}KB)`);
  }
  console.log('\n검수 안내: img/ 의 PNG 를 눈으로 확인 → npm run concept-images -- --upload');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
