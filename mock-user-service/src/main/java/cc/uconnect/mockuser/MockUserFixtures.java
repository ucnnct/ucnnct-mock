package cc.uconnect.mockuser;

import java.util.List;

final class MockUserFixtures {
  private MockUserFixtures() {
  }

  static List<FixtureProfile> build(int initialUserCount) {
    return List.of(
        new FixtureProfile(
            "fixture-campus",
            "Campus graph",
            "Provisioned staging users ready for mixed browse and notification pressure.",
            Math.max(initialUserCount, 32),
            16,
            Math.max(initialUserCount * 3, 96),
            0,
            "ready"
        ),
        new FixtureProfile(
            "fixture-societies",
            "Societies and clubs",
            "Group-heavy staging identities prepared for group creation and member churn.",
            Math.max(initialUserCount / 2, 24),
            12,
            Math.max(initialUserCount * 2, 64),
            24,
            "ready"
        ),
        new FixtureProfile(
            "fixture-media",
            "Media playground",
            "Attachment-focused identities used to stress uploads and file-linked messages.",
            Math.max(initialUserCount / 3, 16),
            6,
            Math.max(initialUserCount, 40),
            Math.max(initialUserCount * 2, 80),
            "ready"
        )
    );
  }
}
