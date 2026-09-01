import javascript

/** Generated from graph/codeql/storage-seeds.json. Do not edit by hand. */
predicate configuredSettingsSdkImport(Import imprt, string provider) {
  (imprt.getImportedPathString().regexpMatch("^bun:bundle$") and provider = "BunBundle")
  or
  (imprt.getImportedPathString().regexpMatch("(?i).*launchdarkly.*") and provider = "LaunchDarkly")
  or
  (imprt.getImportedPathString().regexpMatch("(?i).*statsig.*") and provider = "Statsig")
  or
  (imprt.getImportedPathString().regexpMatch("(?i).*unleash.*") and provider = "Unleash")
  or
  (imprt.getImportedPathString().regexpMatch("(?i).*growthbook.*") and provider = "GrowthBook")
}

predicate configuredExternalSettingsSdkCall(Import imprt, string provider, string calleeName, int keyArgIndex, string mode) {
  (imprt.getImportedPathString().regexpMatch("^bun:bundle$") and provider = "BunBundle" and calleeName = "feature" and keyArgIndex = 0 and mode = "sdk-read")
}

predicate configuredStructuralSeedFile(File f) {
  (f.getRelativePath().regexpMatch("services/analytics/.*"))
  or
  (f.getRelativePath().regexpMatch("utils/config\\.ts"))
  or
  (f.getRelativePath().regexpMatch("cli/print\\.ts"))
  or
  (f.getRelativePath().regexpMatch("utils/settings/.*"))
}

predicate configuredStorageSymbolName(string name) {
  (name = "remoteEvalFeatureValues")
  or
  (name = "envOverrides")
  or
  (name = "pendingExposures")
  or
  (name = "loggedExposures")
  or
  (name = "experimentDataByFeature")
}
