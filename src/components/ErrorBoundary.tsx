import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * Without this, any render-time throw leaves a white page and no explanation.
 * Shows what failed and how to recover instead.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Delfino Ghosts crashed:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <main className="shell page">
        <h1 className="page-title">Something broke</h1>
        <div className="prose" style={{ marginTop: 12 }}>
          <p>
            The archive hit an error it could not recover from. Reloading usually clears it. If it
            keeps happening, the message below is the useful part of a bug report.
          </p>
          <p>
            <code>{this.state.error.message}</code>
          </p>
          <p>
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </p>
        </div>
      </main>
    )
  }
}
