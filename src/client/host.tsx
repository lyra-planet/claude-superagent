/**
 * The standalone host: what the panel got from DeepSeek Harness upstream, provided by the page itself. It picks the interface
 * language, keeps a person's choice of it, and translates with the panel's dictionaries; `PanelProvider` does the rest.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, type LanguageSwitch } from './app.tsx'
import { DICTIONARIES, type Language } from './locales.ts'
import type { T } from './text.ts'

const LANGUAGE_KEY = 'dsh-superagent/language'

/** A translator over one dictionary: each `{name}` takes `values[name]`, a placeholder without a value stays, an unknown key reads as itself. */
export function translator(dictionary: Readonly<Record<string, string>>): T {
  return (key, values) => {
    const template = dictionary[key] ?? key
    return values ? template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? String(values[name]) : match)
      : template
  }
}

/** The language a person chose on this panel before, else the first of the browser's languages the panel has, else English. */
export function initialLanguage(): Language {
  try {
    const chosen = localStorage.getItem(LANGUAGE_KEY)
    if (chosen === 'zh' || chosen === 'en') return chosen
  } catch (error) {
    // The choice is a convenience; a browser that keeps no storage falls back to its languages.
    void error
  }
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const tag of preferred) {
    const base = tag?.toLowerCase().split('-')[0]
    if (base === 'zh' || base === 'en') return base
  }
  return 'en'
}

/** The whole page: the panel in the chosen language, which its header switches. */
export function Standalone() {
  const [language, setLanguage] = useState(initialLanguage)
  const t = useMemo(() => translator(DICTIONARIES[language]), [language])
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    document.title = t('title')
  }, [language, t])
  const choose = useCallback((next: Language) => {
    setLanguage(next)
    try { localStorage.setItem(LANGUAGE_KEY, next) } catch (failure) { void failure /* The choice then lasts until the page closes. */ }
  }, [])
  const switcher = useMemo<LanguageSwitch>(() => ({ value: language, onChange: choose }), [language, choose])
  return <App t={t} language={switcher} />
}
