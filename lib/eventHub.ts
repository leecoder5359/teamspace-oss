/* =====================================================================
   /api/events 공유 연결 관리자 — 탭 하나에 EventSource 하나.
   useAutoRefresh 를 쓰는 화면이 여럿이어도(대시보드는 2개) 서버 스트림은 하나만 연다.
   서버는 스트림마다 3초 간격으로 2쿼리를 돌기 때문이다(감사 P-6).
     - 첫 구독자에 열고, 마지막 구독 해제에 닫는다.
     - 탭이 숨으면 닫고, 다시 보이면 연다(복귀 refetch 는 호출부의 focus/visibility 처리가 맡는다).
     - 이미 연결된 뒤 들어온 구독자에게도 hello 를 알려 폴링 간격을 맞추게 한다.
   브라우저 의존(EventSource·document)은 deps 로 받아 테스트에서 가짜를 넣는다.
   ===================================================================== */

export type EventSourceLike = {
  addEventListener(type: string, fn: () => void): void;
  close(): void;
};

export type HubListener = { onHello(): void; onEvent(): void; onError(): void };

export type HubDeps = {
  /** 새 연결을 연다. 미지원이면 throw 해도 된다(호출부가 폴링으로 폴백). */
  open: () => EventSourceLike;
  isHidden: () => boolean;
  /** 가시성 변화 구독 — 해제 함수를 돌려준다. */
  watchVisibility: (onChange: () => void) => () => void;
};

export type EventHub = { subscribe(listener: HubListener): () => void };

export function createEventHub(deps: HubDeps): EventHub {
  const subs = new Set<HubListener>();
  let es: EventSourceLike | null = null;
  let connected = false;
  let unwatch: (() => void) | null = null;

  const emit = (key: keyof HubListener) => {
    for (const l of [...subs]) l[key]();
  };

  const connect = () => {
    if (es) return;
    let self: EventSourceLike;
    try {
      self = deps.open();
    } catch {
      return; // EventSource 미지원
    }
    es = self;
    const live = () => es === self; // 닫힌 연결의 늦은 이벤트는 버린다
    self.addEventListener("hello", () => {
      if (!live()) return;
      connected = true;
      emit("onHello");
    });
    self.addEventListener("activity", () => live() && emit("onEvent"));
    self.addEventListener("notification", () => live() && emit("onEvent"));
    self.addEventListener("error", () => {
      if (!live()) return;
      connected = false;
      emit("onError");
    });
  };

  const disconnect = () => {
    es?.close();
    es = null;
    connected = false;
  };

  const sync = () => (subs.size > 0 && !deps.isHidden() ? connect() : disconnect());

  return {
    subscribe(listener) {
      subs.add(listener);
      if (!unwatch) unwatch = deps.watchVisibility(sync);
      sync();
      if (connected) listener.onHello();
      return () => {
        subs.delete(listener);
        if (subs.size === 0 && unwatch) {
          unwatch();
          unwatch = null;
        }
        sync();
      };
    },
  };
}
