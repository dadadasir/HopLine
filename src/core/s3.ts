export interface ObjectStorage {
  put(key: string, body: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array>
  list(prefix: string): Promise<{ key: string }[]>
}

export interface S3Config {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  prefix: string
  forcePathStyle: boolean
}

/**
 * Interface stub for an S3-compatible target (MinIO, R2, OSS, AWS).
 * The shape is stable so a signer can be dropped in later; calls do not
 * leave the machine.
 */
export class S3CompatibleStub implements ObjectStorage {
  constructor(private readonly config: S3Config) {}

  describe(): string {
    const root = this.config.forcePathStyle
      ? `${this.config.endpoint.replace(/\/+$/, '')}/${this.config.bucket}`
      : this.config.endpoint
    return `${root}/${this.config.prefix.replace(/^\/+/, '')}`
  }

  async put(key: string, _body: Uint8Array): Promise<void> {
    throw new Error(`S3 同步尚未实现 (${this.config.bucket}/${key})`)
  }

  async get(key: string): Promise<Uint8Array> {
    throw new Error(`S3 同步尚未实现 (${this.config.bucket}/${key})`)
  }

  async list(prefix: string): Promise<{ key: string }[]> {
    throw new Error(`S3 同步尚未实现 (${this.config.bucket}/${prefix})`)
  }
}
