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
  readonly createCalls: NativeSessionCreateOptions[] = []
  readonly promptCalls: NativePromptOptions[] = []
  readonly abortCalls: NativeAbortOptions[] = []
  readonly permissionCalls: NativePermissionReplyOptions[] = []

  createResult: NativeClientResult<NativeSession> = success({ id: 'child-1' })
  promptImplementation: (
    options: NativePromptOptions,
  ) => Promise<NativeClientResult<NativePromptResponse>> = async () =>
    success({ info: {}, parts: [] })
  abortImplementation: (
    options: NativeAbortOptions,
  ) => Promise<NativeClientResult<boolean>> = async () => success(true)
  permissionImplementation: (
    options: NativePermissionReplyOptions,
  ) => Promise<NativeClientResult<boolean>> = async () => success(true)

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
      return this.promptImplementation(options)
    },
    abort: async (
      options: NativeAbortOptions,
    ): Promise<NativeClientResult<boolean>> => {
      this.abortCalls.push(options)
      return this.abortImplementation(options)
    },
  }

  async postSessionIdPermissionsPermissionId(
    options: NativePermissionReplyOptions,
  ): Promise<NativeClientResult<boolean>> {
    this.permissionCalls.push(options)
    return this.permissionImplementation(options)
  }
}
