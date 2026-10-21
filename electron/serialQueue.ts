// 비동기 작업을 하나씩 차례로 돌리는 직렬 큐. 앞 작업이 실패해도 다음 작업은 계속 돈다
export interface SerialQueue { run<T>(fn: () => Promise<T>): Promise<T> }

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn);
      tail = result.catch(() => undefined); // 실패는 호출한 쪽이 받고, 줄은 끊기지 않게 한다
      return result;
    },
  };
}
