import React from "react";

export class ClientErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, errorInfo) {
    // Keep diagnostics in the local browser console. Never render stack traces
    // or participant/session state into the participant-facing page.
    console.error("[participant-ui] uncaught render error", error, errorInfo);
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-xl text-center" role="alert">
          <h1 className="text-2xl font-medium text-gray-900">
            The study page encountered a technical problem
          </h1>
          <p className="mt-3 text-lg text-gray-600">
            Your session has not been intentionally ended. Please reconnect to
            load the latest session state.
          </p>
          <button
            type="button"
            className="mt-5 rounded bg-empirica-600 px-5 py-3 font-medium text-white"
            onClick={() => window.location.reload()}
          >
            Reconnect
          </button>
        </div>
      </div>
    );
  }
}
