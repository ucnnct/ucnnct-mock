package cc.uconnect.mockuser;

import java.time.Instant;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MockUserHealthController {
  @GetMapping("/health")
  public Map<String, Object> health() {
    return Map.of(
        "service", "mock-user-service",
        "status", "ok",
        "environment", "staging",
        "generatedAt", Instant.now().toString()
    );
  }
}
