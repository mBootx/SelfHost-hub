import { Component, ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

interface Props {
  children: ReactNode
  label: string
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}] crashed:`, error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-hover">
            <AlertTriangle className="h-8 w-8 text-red-400" />
          </div>
          <div>
            <p className="text-lg font-semibold">{this.props.label} a rencontre une erreur</p>
            <p className="mt-1 max-w-sm text-sm text-gray-400">{this.state.error.message}</p>
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover"
          >
            <RotateCw className="h-4 w-4" />
            Reessayer
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
