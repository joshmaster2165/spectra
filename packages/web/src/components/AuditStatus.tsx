import { useCallback, useEffect, useState } from "react";
import type { AuditVerification } from "@spectra/schema";

const RECHECK_MS = 30_000;

export async function fetchVerification(sessionId: string): Promise<AuditVerification | undefined> {
  try {
    return await fetch(`/verify?session=${encodeURIComponent(sessionId)}`).then((r) => r.json());
  } catch {
    return undefined;
  }
}

/** Footer status for the session's hash-chained audit log. Click to copy the head hash. */
export function AuditStatus({ sessionId }: { sessionId?: string }) {
  const [result, setResult] = useState<AuditVerification>();
  const [copied, setCopied] = useState(false);

  const check = useCallback(() => {
    if (sessionId) fetchVerification(sessionId).then(setResult);
  }, [sessionId]);

  useEffect(() => {
    setResult(undefined);
    check();
    const t = setInterval(check, RECHECK_MS);
    return () => clearInterval(t);
  }, [check]);

  if (!sessionId || !result) return <span>Audit log —</span>;
  if (!result.ok && !result.badLine) return <span>Audit log: {result.reason}</span>;
  if (!result.ok) {
    return (
      <button className="audit bad" onClick={check} title={result.reason}>
        Audit log FAILED at line {result.badLine}: {result.reason}
      </button>
    );
  }
  const copy = () => {
    if (!result.head) return;
    navigator.clipboard?.writeText(result.head).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
    check();
  };
  return (
    <button className="audit ok" onClick={copy} title={`Head hash ${result.head}\nClick to copy. Record it elsewhere to detect a rewritten log.`}>
      Audit log verified · {result.events} events · head {result.head?.slice(0, 12)}
      {copied ? " · copied" : ""}
    </button>
  );
}
