package cc.uconnect.mockuser;

record ProvisionedMockUser(
    String id,
    String username,
    String displayName,
    String email,
    String password
) {
}
