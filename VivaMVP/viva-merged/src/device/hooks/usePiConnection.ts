import { useEffect, useState } from 'react';
import {
  connectionMonitor,
  PiConnectionStatus,
  PiHealth,
} from '../services/connectionMonitor.service';

/** connectionMonitor 구독. 판정은 서비스가 하고 여기는 리렌더만 잇는다. */
export function usePiConnection(): PiConnectionStatus {
  const [status, setStatus] = useState<PiConnectionStatus>(connectionMonitor.status);

  useEffect(() => {
    setStatus(connectionMonitor.status); // 마운트 전 변화 반영
    return connectionMonitor.onStatusChange(setStatus);
  }, []);

  return status;
}

/** 마이크·스피커 생존 상태. 같은 구독 채널을 쓴다 - monitor 가 헬스만
 * 바뀌어도 통지하므로(commit) 별도 채널이 필요 없다. */
export function usePiDeviceHealth(): PiHealth | null {
  const [health, setHealth] = useState<PiHealth | null>(connectionMonitor.health);

  useEffect(() => {
    setHealth(connectionMonitor.health); // 마운트 전 변화 반영
    return connectionMonitor.onStatusChange(() => setHealth(connectionMonitor.health));
  }, []);

  return health;
}
