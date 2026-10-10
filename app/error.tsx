"use client";

import { useEffect } from "react";
import { ErrorScreen, ErrorHomeLink, ERROR_COPY } from "@/components/ErrorScreen";

export default function Error({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <ErrorScreen
      title={ERROR_COPY.errorTitle}
      body={ERROR_COPY.errorBody}
      digest={error.digest}
      actions={
        <>
          <button className="ws-email-btn" onClick={() => unstable_retry()}>
            다시 시도
          </button>
          <ErrorHomeLink />
        </>
      }
    />
  );
}
