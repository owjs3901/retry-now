import type {
  NativeAbortOptions,
  NativeClientResult,
  NativePermissionReplyOptions,
  NativePromptOptions,
  NativePromptResponse,
  NativeSession,
  NativeSessionClient,
  NativeSessionCreateOptions,
} from '../client.ts'

export function success<T>(data: T): NativeClientResult<T> {
  return { data, error: undefined }
}

export class FakeNativeClient implements NativeSessionClient {
  constructor() {
    this.createResult = success({ id: 'child-1' })
    this.permissionResult = success(true)
  }

  readonly createCalls: NativeSessionCreateOptions[] = []
  readonly promptCalls: NativePromptOptions[] = []
  readonly abortCalls: NativeAbortOptions[] = []
  readonly permissionCalls: NativePermissionReplyOptions[] = []

  createResult: NativeClientResult<NativeSession>
  promptImplementation:
    | ((
        options: NativePromptOptions,
      ) => Promise<NativeClientResult<NativePromptResponse>>)
    | undefined
  abortImplementation:
    | ((options: NativeAbortOptions) => Promise<NativeClientResult<boolean>>)
    | undefined
  permissionResult: NativeClientResult<boolean>

  readonly session = {
    create: async (
      options: NativeSessionCreateOptions,
    ): Promise<NativeClientResult<NativeSession>> => {
      this.createCalls.push(options)
      return this.createResult
    },
    prompt: async (
      options: NativePromptOptions,
    ): Promise<NativeClientResult<NativePromptResponse>> => {
      this.promptCalls.push(options)
      if (this.promptImplementation !== undefined)
        return this.promptImplementation(options)
      return success({ info: {}, parts: [] })
    },
    abort: async (
      options: NativeAbortOptions,
    ): Promise<NativeClientResult<boolean>> => {
      this.abortCalls.push(options)
      if (this.abortImplementation !== undefined)
        return this.abortImplementation(options)
      return success(true)
    },
  }

  async postSessionIdPermissionsPermissionId(
    options: NativePermissionReplyOptions,
  ): Promise<NativeClientResult<boolean>> {
    this.permissionCalls.push(options)
    return this.permissionResult
  }
}
