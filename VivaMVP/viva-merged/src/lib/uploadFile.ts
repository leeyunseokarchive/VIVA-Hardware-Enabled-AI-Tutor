import * as FileSystem from 'expo-file-system';
import { decode } from 'base64-arraybuffer';
import { supabase } from './supabase';

// RN 환경에서 fetch(uri).blob()로 로컬 파일을 읽어 Supabase Storage에 올리면
// "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported" 에러가 난다
// (RN의 Blob 폴리필이 supabase-js 내부에서 만드는 Blob(ArrayBuffer) 패턴을 지원하지 않음).
// 그래서 base64 문자열을 ArrayBuffer로 디코딩해 upload()에 직접 넘긴다 (Repo 2와 동일 패턴).
export async function uploadBase64File(
  bucket: string,
  path: string,
  base64: string,
  contentType: string,
): Promise<string> {
  const arrayBuffer = decode(base64);

  const { error } = await supabase.storage.from(bucket).upload(path, arrayBuffer, {
    contentType,
    upsert: true,
  });
  if (error) {
    throw new Error(`${bucket}/${path} 업로드 실패: ${error.message}`);
  }
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

/** 로컬 파일 URI를 base64 문자열로 읽는다 (업로드 없이). */
export async function readFileAsBase64(localUri: string): Promise<string> {
  return FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
}
