import {views,entity,graphNeighbors,validatePresentation,playPresentation,presentationRun,controlPresentation} from './presentation.mjs';
import {readScene} from '../scene/scene.mjs';
export const presentationSDL=`
 enum PresentationViewKind { FUNCTIONS FLOW GRAPH }
 enum GraphDirection { IN OUT }
 enum PresentationAction { OPEN FOCUS POINTER EXPAND HIDE MOVE ANNOTATIONS }
 enum PresentationControl { PAUSE RESUME CANCEL }
 type PresentationView { id: ID!, kind: PresentationViewKind!, file: String!, sceneId: ID, rootStableId: ID!, profile: String! }
 type EntityRepresentation { viewId: ID!, file: String!, cellId: ID!, stableId: ID!, kind: PresentationViewKind! }
 type CodeEntity { stableId: ID!, profile: String!, labels: [String!]!, properties: JSON!, annotations: JSON!, representations: [EntityRepresentation!]! }
 input PresentationPosition { stableId: ID!, x: Float!, y: Float! }
 input PresentationStepInput {
  atMs: Int!, action: PresentationAction!, viewId: ID!, stableId: ID, cellId: ID,
  durationMs: Int, pointerId: ID, direction: GraphDirection, types: [String!], targets: [ID!],
  positions: [PresentationPosition!], visibleThrough: Int
 }
 input PresentationInput { steps: [PresentationStepInput!]! }
 type PresentationRun { runId: ID!, status: String!, stepIndex: Int!, events: JSON!, error: String }
 extend type AnnotationPlanNode { entity(profile: String!): CodeEntity! }
 extend type AnnotationWorkItem { entity(profile: String!): CodeEntity! }
 extend type ValueOriginTask { entity(profile: String!): CodeEntity! }
 extend type Query {
  presentationViews: [PresentationView!]!
  codeEntity(stableId: ID!, profile: String = "aura"): CodeEntity!
  presentationScene(sceneId: ID!): JSON!
  presentationNeighbors(viewId: ID!, stableId: ID!, direction: GraphDirection!, types: [String!]!, limit: Int = 30): JSON!
  presentationRun(runId: ID!): PresentationRun!
 }
 extend type Mutation {
  validatePresentation(input: PresentationInput!): JSON!
  playPresentation(input: PresentationInput!): PresentationRun!
  controlPresentation(runId: ID!, action: PresentationControl!): PresentationRun!
 }
`;
export const attachEntity=node=>node?{...node,entity:({profile='aura'})=>entity(node.stableId,profile)}:node;
export function attachPlanEntities(plan){return {...plan,...Object.fromEntries(['nodes','available','working','waiting'].map(k=>[k,(plan[k]||[]).map(attachEntity)]))};}
export function presentationRoot({send}={}){return {
 presentationViews:()=>views(),codeEntity:({stableId,profile})=>entity(stableId,profile),
 presentationScene:({sceneId})=>readScene(sceneId),presentationNeighbors:graphNeighbors,
 presentationRun:({runId})=>presentationRun(runId),validatePresentation:({input})=>validatePresentation(input),
 playPresentation:({input})=>playPresentation(input,{send}),controlPresentation,
};}
