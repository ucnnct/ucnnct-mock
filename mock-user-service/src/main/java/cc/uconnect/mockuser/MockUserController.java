package cc.uconnect.mockuser;

import jakarta.validation.Valid;
import java.util.Map;
import java.util.NoSuchElementException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/mock-users")
public class MockUserController {
  private final MockUserRegistry registry;

  public MockUserController(MockUserRegistry registry) {
    this.registry = registry;
  }

  @GetMapping("/runtime")
  public MockUserRuntime runtime() {
    return registry.runtime();
  }

  @GetMapping("/pools")
  public Object pools() {
    return registry.pools();
  }

  @GetMapping("/fixtures")
  public Object fixtures() {
    return registry.fixtures();
  }

  @GetMapping("/leases")
  public Object leases() {
    return registry.leases();
  }

  @PostMapping("/leases")
  public ResponseEntity<?> createLease(@Valid @RequestBody LeaseRequest request) {
    try {
      return ResponseEntity.status(HttpStatus.CREATED).body(registry.createLease(request));
    } catch (IllegalArgumentException | IllegalStateException exception) {
      return error(HttpStatus.BAD_REQUEST, exception.getMessage());
    }
  }

  @PostMapping("/leases/{leaseId}/release")
  public ResponseEntity<?> releaseLease(@PathVariable String leaseId) {
    try {
      return ResponseEntity.ok(registry.releaseLease(leaseId));
    } catch (NoSuchElementException exception) {
      return error(HttpStatus.NOT_FOUND, exception.getMessage());
    }
  }

  @PostMapping("/runs/{runId}/release")
  public ResponseEntity<?> releaseRun(@PathVariable String runId) {
    try {
      return ResponseEntity.ok(registry.releaseRun(runId));
    } catch (NoSuchElementException exception) {
      return error(HttpStatus.NOT_FOUND, exception.getMessage());
    }
  }

  @GetMapping("/health")
  public Object internalHealth() {
    return registry.runtime();
  }

  private ResponseEntity<Map<String, String>> error(HttpStatus status, String message) {
    return ResponseEntity.status(status).body(Map.of("message", message));
  }
}
