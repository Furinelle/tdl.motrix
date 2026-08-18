declare module 'motrix:plugin-api' {
  export interface BeforeCreateHttpContext {
    readonly type: 'http'
    readonly uris: ReadonlyArray<string>
    readonly saveDir: string
    readonly filename?: string
    readonly signal: AbortSignal
    update(
      patch: Partial<{
        uris: string[]
        filename: string
        connections: number
        headers: Array<{ name: string; value: string }>
        proxy: string
      }>
    ): Promise<void>
  }
  export const hooks: {
    beforeCreate(
      fn: (ctx: BeforeCreateHttpContext) => Promise<BeforeCreateHttpContext>
    ): void
  }
  export const log: {
    info(msg: string, fields?: Record<string, unknown>): void
    error(msg: string, fields?: Record<string, unknown>): void
  }
  export const http: {
    request<R extends 'text' | 'json' | 'bytes'>(opts: {
      method: 'GET' | 'POST'
      url: string
      responseType: R
      timeoutMs?: number
      body?: string | { type: 'json'; data: unknown }
    }): Promise<{
      status: number
      body: R extends 'json' ? unknown : string
    }>
  }
}
