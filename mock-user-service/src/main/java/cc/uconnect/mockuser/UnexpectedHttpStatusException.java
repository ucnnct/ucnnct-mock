package cc.uconnect.mockuser;

final class UnexpectedHttpStatusException extends IllegalStateException {
  private final int statusCode;

  UnexpectedHttpStatusException(int statusCode, String message) {
    super(message);
    this.statusCode = statusCode;
  }

  int statusCode() {
    return statusCode;
  }
}
