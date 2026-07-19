export type NativeClientResult<T> =
  | {
      readonly data: T
      readonly error: undefined
      readonly request?: Request
      readonly response?: Response
    }
  | {
      readonly data: undefined
      readonly error: unknown
      readonly request?: Request
      readonly response?: Response
    }

export interface NativeSession {
  readonly id: string
}

export interface NativeSessionCreateOptions {
  readonly body: {
    readonly parentID?: string
    readonly title?: string
  }
  readonly query?: {
    readonly directory?: string
  }
}

export interface NativePromptOptions {
  readonly path: { readonly id: string }
  readonly query?: { readonly directory?: string }
  readonly body: {
    readonly model?: {
      readonly providerID: string
      readonly modelID: string
    }
    readonly agent?: string
    readonly parts: {
      readonly type: 'text'
      readonly text: string
    }[]
  }
}

export interface NativePromptResponse {
  readonly info: { readonly error?: unknown }
  readonly parts: readonly unknown[]
}

export interface NativeAbortOptions {
  readonly path: { readonly id: string }
  readonly query?: { readonly directory?: string }
}

export interface NativePermissionReplyOptions {
  readonly path: {
    readonly id: string
    readonly permissionID: string
  }
  readonly query?: { readonly directory?: string }
  readonly body: { readonly response: 'once' | 'always' | 'reject' }
}

export interface NativeSessionClient {
  readonly session: {
    create(
      options: NativeSessionCreateOptions,
    ): Promise<NativeClientResult<NativeSession>>
    prompt(
      options: NativePromptOptions,
    ): Promise<NativeClientResult<NativePromptResponse>>
    abort(options: NativeAbortOptions): Promise<NativeClientResult<boolean>>
  }
  postSessionIdPermissionsPermissionId(
    options: NativePermissionReplyOptions,
  ): Promise<NativeClientResult<boolean>>
}
