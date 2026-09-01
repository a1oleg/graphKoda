# UI Object Badge Defects

Date: 2026-06-03

## Fixed

- Broad family-to-object leakage.
  `UiDomainAction` assigned every `BusinessDomain` in a family to each action. This made objects like `ApiAttachBot`, `BotAppPermissions`, `ApiChatAdminRights`, and other sibling domain objects appear on unrelated UI nodes.
  Fix: domain action labels are now narrowed to domain object tokens matched by the target function name, with an explicit `global.phoneCall` exception for `requestCall`/`hangUp`-style function names.

- Cross-object function leakage inside one family badge.
  `EXPOSES_FAMILY` stored `domain_labels` and `function_names` as independent aggregate lists. UI then showed every function in the family on every object in that family, for example `ApiChat` receiving unrelated handlers such as premium, bot, or message handlers.
  Fix: `EXPOSES_FAMILY` now stores `object_details_json`, preserving `object -> evidence -> functions -> exposure surfaces`; UI object badges read this object-specific mapping.

- Display-region handlers shown as object functions.
  `surface-object-boundary` evidence describes where an object is displayed/bound, not which CRUD/action function starts there. It previously copied local `handle*` function names into object badges.
  Fix: boundary/display evidence still contributes object presence, but contributes no function names.

- Router/deep-link leakage into call features.
  `BotMenuButton` reached `ApiGroupCall` and `ApiPhoneCall` through `processDeepLink -> joinVoiceChatByLink -> requestMasterAndCallAction`.
  Fix: `processDeepLink` and `requestMasterAndCallAction` are treated as feature-explorer router barriers.

- Wrapper target noise.
  `requestMasterAndRequestCall` and `requestMasterAndJoinGroupCall` appeared as business targets and pulled in sibling call domains.
  Fix: wrapper targets are skipped as displayed target functions while exact downstream targets such as `requestCall` and `joinGroupCall` remain reachable.

- Group-call guard read shown as phone-call feature.
  `joinGroupCall` reads `global.phoneCall` as a guard, so `handleEnterVoiceChatClick` was marked as `ApiPhoneCall`.
  Fix: phone-call reads inside explicit group-call/voice-chat handlers are filtered from UI domain actions.

- Start-call button was not reachable as a tree leaf.
  `HeaderActions` had a local `Button(onClick=handleRequestCall)`, but the tree only exposed child view surfaces such as `HeaderMenuContainerAsync`.
  Fix: action-triggering `UiAffordance` nodes that do not render their own child `ViewSurface` are now emitted as leaf nodes in the explorer tree.

## Verification

- `BotMenuButton` has 0 `ApiPhoneCall` / `ApiGroupCall` rows.
- `HeaderActions` has a leaf affordance with `ApiPhoneCall: handleRequestCall, requestCall`.
- `HeaderMenuContainer.handleCall` and `handleVideoCall` map to `global.phoneCall -> requestCall`.
- `HeaderMenuContainer.handleEnterVoiceChatClick` maps to `global.groupCalls` only.
- Domain-action business-domain edges dropped from about 14.6k broad edges to about 1.1k narrowed edges.
- Full object-specific audit covers 60 objects and currently reports 0 object/function mismatches.

## Remaining Notes

- Some high-level container nodes still accumulate multiple objects because they contain multiple legitimate child actions. This is expected for path navigation.
- Affordance labels depend on current `UiAffordance` extraction. Some leaves may display generic names like `Button -> Button`; the object/function badge is the reliable feature signal.
