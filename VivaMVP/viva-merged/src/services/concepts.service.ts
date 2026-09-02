/** 등록 개념 목록 서비스 — concepts 테이블 + concept-images 버킷 (스펙
 * 2026-08-13 Supabase 이전). 번들 conceptList/registry 를 대체한다.
 * 실패는 빈 목록으로 삼킨다 — knownConcepts 가 비면 explainConcept 가
 * board_prompt 생성 경로로 가는 기존 계약이 그대로 폴백이다. */
import { supabase } from '../lib/supabase';

export interface ConceptInfo {
  id: string;
  name: string;
  aliases: string[];
  sketch: string;
  imageUrl?: string;
}

interface ConceptRow {
  id: string;
  name: string;
  aliases: string[] | null;
  sketch: string;
  image_path: string | null;
}

// ponytail: 모듈 변수 캐시 - 앱 세션당 1회 fetch, 개념이 세션 중 바뀌면
// 재시작으로 반영. TTL/실시간 갱신이 필요해지면 그때 붙인다.
let cached: ConceptInfo[] | null = null;

export function clearConceptsCache(): void {
  cached = null;
}

export async function fetchConcepts(): Promise<ConceptInfo[]> {
  if (cached) return cached;
  try {
    const { data, error } = await supabase
      .from('concepts')
      .select('id, name, aliases, sketch, image_path');
    if (error) throw new Error(error.message);
    cached = ((data ?? []) as ConceptRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      aliases: row.aliases ?? [],
      sketch: row.sketch,
      imageUrl: row.image_path
        ? supabase.storage.from('concept-images').getPublicUrl(row.image_path).data.publicUrl
        : undefined,
    }));
    return cached;
  } catch (err) {
    console.warn('[ConceptsService] fetch 실패 - 생성 경로 폴백:', err);
    return [];
  }
}
