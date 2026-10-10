import { ErrorScreen, ErrorHomeLink, ERROR_COPY } from "@/components/ErrorScreen";

export default function NotFound() {
  return <ErrorScreen title={ERROR_COPY.notFoundTitle} body={ERROR_COPY.notFoundBody} actions={<ErrorHomeLink />} />;
}
