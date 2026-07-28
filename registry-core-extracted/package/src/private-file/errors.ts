export type PrivateFileErrorCode =
  | "DURABILITY_UNCERTAIN"
  | "PRIVATE_FILE_BUSY"
  | "PRIVATE_FILE_INVALID"
  | "PRIVATE_FILE_UNSAFE"

export class PrivateFileError extends Error {
  constructor(readonly code: PrivateFileErrorCode, message: string) {
    super(message)
    this.name = "PrivateFileError"
  }
}
