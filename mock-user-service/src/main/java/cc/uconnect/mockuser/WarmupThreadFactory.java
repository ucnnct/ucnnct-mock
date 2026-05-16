package cc.uconnect.mockuser;

import java.util.concurrent.ThreadFactory;

final class WarmupThreadFactory implements ThreadFactory {
  @Override
  public Thread newThread(Runnable runnable) {
    Thread thread = new Thread(runnable, "mock-user-warmup");
    thread.setDaemon(true);
    return thread;
  }
}
