/* =====================================================================
   /api/events 공유 연결 관리자 — 탭 하나에 EventSource 하나.
   useAutoRefresh 를 쓰는 화면이 여럿이어도(대시보드는 2개) 서버 스트림은 하나만 연다.
   서버는 스트림마다 3초 간격으로 2쿼리를 돌기 때문이다(감사 P-6).
     - 첫 구독자에 열고, 마지막 구독 해제에 닫는다.
     - 탭이 숨으면 닫고, 다시 보이면 연다(복귀 refetch 는 호출부의 focus/visibility 처리가 맡는다).
     - 이미 연결된 뒤 들어온 구독자에게도 hello 를 알려 폴링 간격을 맞추게 한다.
     - 에러로 연결이 CLOSED(readyState 2 — 401·502 등 비200 응답)가 되면 브라우저가 다시 잇지 않으므로
       구독자가 있고 탭이 보이는 동안 5초→2배→60초 상한 백오프로 새로 연다. hello 를 받으면 백오프 초기화.
   브라우저 의존(EventSource·document)은 deps 로 받아 테스트에서 가짜를 넣는다.
   ===================================================================== */

export type EventSourceLike = {
  /** 0 CONNECTING · 1 OPEN · 2 CLOSED (EventSource 표준). */
  readonly readyState: number;
  addEventListener(type: string, fn: (ev: { data?: string }) => void): void;
  close(): void;
};

/** 구독자에게 넘기는 이벤트. activity 는 서버가 보낸 본문 필드(app/api/events)를, 알림은 종류만 싣는다. */
export type HubEvent =
  | { type: "activity"; verb?: string; targetType?: string; targetId?: string | null; boardId?: string | null }
  | { type: "notification" };

export type HubListener = { onHello(): void; onEvent(ev: HubEvent): void; onError(): void };

export type HubDeps = {
  /** 새 연결을 연다. 미지원이면 throw 해도 된다(호출부가 폴링으로 폴백). */
  open: () => EventSourceLike;
  isHidden: () => boolean;
  /** 가시성 변화 구독 — 해제 함수를 돌려준다. */
  watchVisibility: (onChange: () => void) => () => void;
  /** 지연 실행 — 취소 함수를 돌려준다. 기본은 setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

const CLOSED = 2;
export const RECONNECT_BASE_MS = 5_000;
export const RECONNECT_MAX_MS = 60_000;

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export type EventHub = { subscribe(listener: HubListener): () => void };

/** activity 본문에서 거르기에 쓰는 필드만 꺼낸다. 깨진 본문이면 빈 객체(→ 구독자는 종류만 본다). */
function activityFields(data: string | undefined): Omit<Extract<HubEvent, { type: "activity" }>, "type"> {
  try {
    const { verb, targetType, targetId, boardId } = JSON.parse(data ?? "") as Record<string, string | null | undefined>;
    return Object.fromEntries(Object.entries({ verb, targetType, targetId, boardId }).filter(([, v]) => v !== undefined));
  } catch {
    return {};
  }
}

export function createEventHub(deps: HubDeps): EventHub {
  const subs = new Set<HubListener>();
  let es: EventSourceLike | null = null;
  let connected = false;
  let unwatch: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;
  let retryMs = RECONNECT_BASE_MS;
  const schedule = deps.schedule ?? defaultSchedule;

  const emit = (key: "onHello" | "onError") => {
    for (const l of [...subs]) l[key]();
  };
  const emitEvent = (ev: HubEvent) => {
    for (const l of [...subs]) l.onEvent(ev);
  };

  const clearRetry = () => {
    cancelRetry?.();
    cancelRetry = null;
  };

  const connect = () => {
    if (es) return;
    clearRetry();
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
      retryMs = RECONNECT_BASE_MS;
      emit("onHello");
    });
    self.addEventListener("activity", (e) => live() && emitEvent({ ...activityFields(e.data), type: "activity" }));
    self.addEventListener("notification", () => live() && emitEvent({ type: "notification" }));
    self.addEventListener("error", () => {
      if (!live()) return;
      connected = false;
      if (self.readyState === CLOSED) {
        // 브라우저가 포기한 연결 — 버리고 백오프 뒤 sync 로 다시 연다(그 사이 숨거나 다 떠나면 취소).
        es = null;
        clearRetry();
        const delay = retryMs;
        retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
        cancelRetry = schedule(() => {
          cancelRetry = null;
          sync();
        }, delay);
      }
      emit("onError");
    });
  };

  const disconnect = () => {
    clearRetry();
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
