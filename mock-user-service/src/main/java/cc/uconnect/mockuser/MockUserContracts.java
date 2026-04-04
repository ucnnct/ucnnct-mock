package cc.uconnect.mockuser;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.List;

record BehaviorWeights(
    @Min(0) @Max(100) double browse,
    @Min(0) @Max(100) double privateMessage,
    @Min(0) @Max(100) double group,
    @Min(0) @Max(100) double media,
    @Min(0) @Max(100) double social,
    @Min(0) @Max(100) double notificationCheck
) {
}

record MockUserSummary(
    String id,
    String username,
    String displayName,
    String email,
    String poolId,
    List<String> tags
) {
}

record LeasedMockUser(
    String id,
    String username,
    String displayName,
    String email,
    String poolId,
    List<String> tags,
    String password
) {
}

record UserPoolSnapshot(
    String id,
    String name,
    String purpose,
    int total,
    int available,
    int leased,
    List<String> tags,
    String notes
) {
}

record FixtureProfile(
    String id,
    String name,
    String summary,
    int users,
    int groups,
    int friendships,
    int attachments,
    String state
) {
}

record LeaseRequest(
    @NotBlank String runId,
    @NotBlank String runName,
    @NotBlank String environment,
    @NotNull @Min(1) @Max(20_000) Integer requestedUsers,
    @NotNull BehaviorWeights weights
) {
}

record LeaseSnapshot(
    String id,
    String runId,
    String runName,
    String poolId,
    String poolName,
    int users,
    String issuedAt,
    String state
) {
}

record LeaseResponse(
    LeaseSnapshot lease,
    List<LeasedMockUser> assignedUsers
) {
}

record MockUserRuntime(
    String service,
    String environment,
    int totalUsers,
    int availableUsers,
    int leasedUsers,
    int activeLeases,
    String generatedAt
) {
}
