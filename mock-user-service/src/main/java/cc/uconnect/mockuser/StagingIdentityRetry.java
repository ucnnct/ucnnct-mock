package cc.uconnect.mockuser;

import java.util.concurrent.Callable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class StagingIdentityRetry {
  private static final Logger log = LoggerFactory.getLogger(StagingIdentityRetry.class);

  private StagingIdentityRetry() {
  }

  static <T> T retry(String context, int maxAttempts, long initialDelayMs, Callable<T> operation) {
    long backoffMs = initialDelayMs;
    for (int attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return operation.call();
      } catch (UnexpectedHttpStatusException exception) {
        if (!isRetryableStatus(exception.statusCode()) || attempt == maxAttempts) {
          throw exception;
        }
        log.warn(
            "Retrying {} after transient status {} (attempt {}/{})",
            context,
            exception.statusCode(),
            attempt,
            maxAttempts
        );
      } catch (Exception exception) {
        if (attempt == maxAttempts) {
          throw new IllegalStateException("Operation failed for " + context, exception);
        }
        log.warn(
            "Retrying {} after transient failure (attempt {}/{})",
            context,
            attempt,
            maxAttempts,
            exception
        );
      }

      sleep(backoffMs, context + " retry backoff");
      backoffMs = Math.min(backoffMs * 2L, 15_000L);
    }
    throw new IllegalStateException("Operation failed for " + context);
  }

  static boolean isRetryableStatus(int statusCode) {
    return statusCode == 429 || (statusCode >= 500 && statusCode <= 504);
  }

  static void sleep(long durationMs, String context) {
    try {
      Thread.sleep(durationMs);
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Interrupted during " + context, exception);
    }
  }
}
