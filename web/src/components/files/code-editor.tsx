import * as React from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { openSearchPanel, search } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import type { Extension } from '@codemirror/state'

import { useTheme } from '@/components/theme-provider'
import { languageLoaderFor, shouldWrap } from './file-types'

// Transparent chrome so the editor inherits the app's card surface rather than
// CodeMirror's own background — keeps the file pane materially consistent.
const baseTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', height: '100%', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--color-muted-foreground)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-content': { caretColor: 'var(--color-primary)' },
})

export interface CodeEditorProps {
  /** Filename — drives the language grammar + wrap behaviour. */
  name: string
  value: string
  editable: boolean
  onChange?: (value: string) => void
}

/** What the viewer's header can ask of the editor. In-file search is the only
 *  member today, and it exists because `Mod-f` is unreachable on a phone. */
export interface CodeEditorHandle {
  /** Open CodeMirror's search panel (the `Mod-f` panel, opened by a button). */
  openSearch: () => void
}

/** CodeMirror 6 editor. Loads the language grammar lazily and
 *  themes to match the active light/dark mode. */
export const CodeEditor = React.forwardRef<CodeEditorHandle, CodeEditorProps>(
  function CodeEditor({ name, value, editable, onChange }, ref) {
  const { resolvedTheme } = useTheme()
  const [lang, setLang] = React.useState<Extension | null>(null)
  const cmRef = React.useRef<ReactCodeMirrorRef>(null)

  React.useImperativeHandle(ref, () => ({
    openSearch: () => {
      const view = cmRef.current?.view
      if (view) openSearchPanel(view)
    },
  }))

  React.useEffect(() => {
    // `name` is constant for a given editor instance (FileViewer is keyed by
    // path), so the initial `null` is already correct for no-grammar files —
    // we only ever set state asynchronously once the grammar resolves.
    let alive = true
    const loader = languageLoaderFor(name)
    if (!loader) return
    loader()
      .then((ext) => {
        if (alive) setLang(ext)
      })
      .catch(() => {
        /* unknown grammar — fall back to plain text (lang stays null) */
      })
    return () => {
      alive = false
    }
  }, [name])

  const extensions = React.useMemo(() => {
    // `search({top: true})` EXPLICITLY. `basicSetup` already pulls
    // `@codemirror/search` in transitively (searchKeymap +
    // highlightSelectionMatches), so `Mod-f` very likely already worked on
    // desktop — but as an implicit transitive default, with the panel wherever
    // the default put it and no way at all to reach it from a phone. Declaring
    // it here makes the panel's position ours, and `@codemirror/search` is now
    // a declared dependency instead of a phantom one resolved only by the
    // lockfile (the thing that breaks on the next dedupe).
    const exts: Extension[] = [baseTheme, search({ top: true })]
    if (shouldWrap(name)) exts.push(EditorView.lineWrapping)
    if (lang) exts.push(lang)
    return exts
  }, [name, lang])

  return (
    <CodeMirror
      ref={cmRef}
      value={value}
      onChange={onChange}
      editable={editable}
      readOnly={!editable}
      theme={resolvedTheme === 'dark' ? oneDark : 'light'}
      extensions={extensions}
      height="100%"
      className="h-full text-[13px]"
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: editable,
        highlightActiveLineGutter: editable,
        foldGutter: false,
        autocompletion: false,
      }}
    />
  )
  },
)
