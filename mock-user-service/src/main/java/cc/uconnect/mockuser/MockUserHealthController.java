package cc.uconnect.mockuser;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MockUserHealthController {
  private final MockUserRegistry registry;

  public MockUserHealthController(MockUserRegistry registry) {
    this.registry = registry;
  }

  @GetMapping("/health")
  public Map<String, Object> health() {
    MockUserRuntime runtime = registry.runtime();
    return Map.of(
        "service", runtime.service(),
        "status", "ok",
        "environment", runtime.environment(),
        "activeLeases", runtime.activeLeases(),
        "generatedAt", runtime.generatedAt()
    );
  }
}
