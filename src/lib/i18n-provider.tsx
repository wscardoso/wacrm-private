"use client";

import { useState, useEffect, createContext, useContext, useCallback } from "react";
import { NextIntlClientProvider } from "next-intl";
import { LOCALE_COOKIE, DEFAULT_LOCALE, type Locale } from "@/lib/i18n";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  messages: Record<string, unknown>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function useLocale() {
  const ctx = useContext(I18nContext);
  if (!ctx) return { locale: DEFAULT_LOCALE as Locale, setLocale: () => {} };
  return ctx;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [messages, setMessages] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const saved = getCookie(LOCALE_COOKIE);
    const initial: Locale =
      saved === "pt-BR" || saved === "en" ? saved : getBrowserLocale();
    setLocaleState(initial);
    loadMessages(initial).then(setMessages);
  }, []);

  const setLocale = useCallback((locale: Locale) => {
    setLocaleState(locale);
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; SameSite=Lax`;
    loadMessages(locale).then(setMessages);
  }, []);

  return (
    <I18nContext.Provider value={{ locale, setLocale, messages }}>
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="America/Sao_Paulo" onError={() => {}}>
        {children}
      </NextIntlClientProvider>
    </I18nContext.Provider>
  );
}

function getCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

function getBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const lang = navigator.language;
  if (lang.startsWith("pt")) return "pt-BR";
  return DEFAULT_LOCALE;
}

async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  try {
    const mod = await import(`../../messages/${locale}.json`);
    return mod.default;
  } catch {
    const mod = await import(`../../messages/en.json`);
    return mod.default;
  }
}
