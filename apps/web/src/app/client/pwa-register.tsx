"use client";

import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function ClientPwaRegister() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw-client.js").catch(() => undefined);
    }

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      ("standalone" in navigator && Boolean((navigator as { standalone?: boolean }).standalone));
    setInstalled(standalone);

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isSafari = /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);
    setIosHint(isIos && isSafari && !standalone);

    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", () => {
      setInstalled(true);
      setDeferred(null);
    });
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  if (installed) return null;

  if (deferred) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-50 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          className="w-full border border-[#5ee7ff] bg-[#5ee7ff] px-4 py-3 text-sm font-bold tracking-wide text-[#041018] shadow-[0_0_28px_rgba(94,231,255,0.35)]"
          onClick={async () => {
            await deferred.prompt();
            setDeferred(null);
          }}
        >
          Instalēt VS Client
        </button>
      </div>
    );
  }

  if (iosHint) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-50 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="border border-[#5ee7ff]/25 bg-[#070d14]/95 px-4 py-3 text-center text-[12px] leading-relaxed text-[#8aa3b8] backdrop-blur">
          <strong className="text-[#5ee7ff]">Pievienot kā app:</strong> Safari → Share →{" "}
          <em>Add to Home Screen</em> → Add
        </div>
      </div>
    );
  }

  return null;
}
