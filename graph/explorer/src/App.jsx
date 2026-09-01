import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApolloClient, HttpLink, InMemoryCache, gql } from '@apollo/client';
import { ApolloProvider, useQuery } from '@apollo/client/react';
import './styles.css';

const client = new ApolloClient({
  link: new HttpLink({ uri: '/graphql' }),
  cache: new InMemoryCache(),
});

const PHASES_QUERY = gql`
  query PhaseCascade {
    phases {
      key
      label
      phaseShape
      canExpandFunctions
      head {
        startLine
        stableId
      }
      tail {
        startLine
        stableId
      }
      functions {
        stableId
        name
        repoRelativePath
        startLine
        endLine
      }
    }
  }
`;

const FUNCTION_STAGES_QUERY = gql`
  query FunctionStages($stableId: ID!, $phaseKey: ID!) {
    function(stableId: $stableId) {
      stableId
      name
      repoRelativePath
      stages(phaseKey: $phaseKey) {
        id
        index
        label
        signature
        startLine
        endLine
        sectionCount
        stepCount
        callCount
        resourceCount
        sections {
          id
          index
          label
          signature
          startLine
          endLine
          stepCount
          calls {
            targetName
            calleeText
            line
          }
          resources {
            resourceName
            resourceKind
            accessType
          }
          steps {
            stableId
            operationCode
            actionText
            startLine
            labels
          }
        }
      }
    }
  }
`;

function Badge({ children }) {
  return <span className="badge">{children}</span>;
}

function SelectField({ label, value, disabled, children, onChange }) {
  return (
    <label className="select-field">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

function EmptyState({ children }) {
  return <div className="empty-state">{children}</div>;
}

function SectionDetails({ section }) {
  if (!section) return <EmptyState>Section не выбрана.</EmptyState>;

  return (
    <div className="detail-card">
      <div className="detail-title">
        <h2>{section.index}. {section.label}</h2>
        <Badge>{section.signature}</Badge>
      </div>
      <div className="meta-row">
        <span>lines {section.startLine}-{section.endLine}</span>
        <span>{section.stepCount} steps</span>
      </div>

      <div className="detail-grid">
        <div>
          <h3>Calls</h3>
          {section.calls.length ? section.calls.map((call, index) => (
            <div className="branch call" key={`${call.targetName}-${index}`}>
              <strong>{call.targetName || call.calleeText}</strong>
              <span>line {call.line || '?'}</span>
            </div>
          )) : <p className="muted">Нет вызовов.</p>}
        </div>
        <div>
          <h3>Stateful / external</h3>
          {section.resources.length ? section.resources.map((resource, index) => (
            <div className="branch resource" key={`${resource.resourceName}-${index}`}>
              <strong>{resource.resourceName}</strong>
              <span>{resource.accessType || 'touch'} / {resource.resourceKind}</span>
            </div>
          )) : <p className="muted">Нет resource-trace.</p>}
        </div>
      </div>

      <h3>Steps</h3>
      <div className="steps">
        {section.steps.map((step) => (
          <div className="step" key={step.stableId}>
            <code>{step.stableId}</code>
            <strong>{step.operationCode || step.actionText || 'step'}</strong>
            <span>{(step.labels || []).join(', ')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CascadeScreen() {
  const [phaseKey, setPhaseKey] = useState('');
  const [functionId, setFunctionId] = useState('');
  const [stageId, setStageId] = useState('');
  const [sectionId, setSectionId] = useState('');

  const phasesResult = useQuery(PHASES_QUERY);
  const phases = phasesResult.data?.phases || [];
  const selectedPhase = useMemo(
    () => phases.find((phase) => phase.key === phaseKey) || phases[0],
    [phases, phaseKey],
  );
  const availableFunctions = selectedPhase?.functions || [];
  const selectedFunction = availableFunctions.find((fn) => fn.stableId === functionId) || availableFunctions[0] || null;

  const stagesResult = useQuery(FUNCTION_STAGES_QUERY, {
    variables: { stableId: selectedFunction?.stableId || '', phaseKey: selectedPhase?.key || '' },
    skip: !selectedFunction?.stableId || !selectedPhase?.key,
  });
  const stages = stagesResult.data?.function?.stages || [];
  const selectedStage = stages.find((stage) => stage.id === stageId) || stages[0] || null;
  const sections = selectedStage?.sections || [];
  const selectedSection = sections.find((section) => section.id === sectionId) || sections[0] || null;

  function choosePhase(nextPhaseKey) {
    setPhaseKey(nextPhaseKey);
    setFunctionId('');
    setStageId('');
    setSectionId('');
  }

  function chooseFunction(nextFunctionId) {
    setFunctionId(nextFunctionId);
    setStageId('');
    setSectionId('');
  }

  function chooseStage(nextStageId) {
    setStageId(nextStageId);
    setSectionId('');
  }

  if (phasesResult.loading) return <main className="single-screen"><EmptyState>Загружаю каталог фаз...</EmptyState></main>;
  if (phasesResult.error) return <main className="single-screen"><EmptyState>{phasesResult.error.message}</EmptyState></main>;

  return (
    <main className="single-screen">
      <header className="screen-header">
        <div>
          <h1>Agent turn graph cascade</h1>
          <p>Phase &gt; Function &gt; Stage &gt; Section. Фазы заданы в GraphQL-схеме; Stage/Section вычисляются из Neo4j.</p>
        </div>
      </header>

      <section className="cascade-bar">
        <SelectField label="Phase" value={selectedPhase?.key || ''} onChange={choosePhase}>
          {phases.map((phase) => (
            <option key={phase.key} value={phase.key}>
              {phase.label} ({phase.phaseShape})
            </option>
          ))}
        </SelectField>

        <SelectField
          label="Function (:Fn)"
          value={selectedFunction?.stableId || ''}
          disabled={!availableFunctions.length}
          onChange={chooseFunction}
        >
          {availableFunctions.length ? availableFunctions.map((fn) => (
            <option key={fn.stableId} value={fn.stableId}>{fn.name} - {fn.repoRelativePath}</option>
          )) : <option value="">доступно только для Input Intake</option>}
        </SelectField>

        <SelectField
          label="Stage"
          value={selectedStage?.id || ''}
          disabled={!selectedFunction || stagesResult.loading || !stages.length}
          onChange={chooseStage}
        >
          {stages.length ? stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.index}. {stage.label} / {stage.sectionCount} sections
            </option>
          )) : <option value="">вычисляется из Neo4j, пока пусто</option>}
        </SelectField>

        <SelectField
          label="Section"
          value={selectedSection?.id || ''}
          disabled={!selectedStage || !sections.length}
          onChange={setSectionId}
        >
          {sections.length ? sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.index}. {section.label} / {section.startLine}-{section.endLine}
            </option>
          )) : <option value="">вычисляется из Neo4j, пока пусто</option>}
        </SelectField>
      </section>

      <section className="status-strip">
        <div>
          <strong>{selectedPhase?.label}</strong>
          <Badge>{selectedPhase?.phaseShape}</Badge>
          <span>head {selectedPhase?.head?.startLine || '?'}</span>
          <span>tail {selectedPhase?.tail?.startLine || '?'}</span>
        </div>
        <div>
          {selectedPhase?.canExpandFunctions
            ? 'Function внесена в schema catalog; Stage/Section читаются из графа.'
            : 'Эта Phase пока только каталог: Function boundary не внесена в schema catalog.'}
        </div>
      </section>

      {stagesResult.loading && selectedFunction ? (
        <EmptyState>Загружаю Stage/Section из Neo4j...</EmptyState>
      ) : selectedFunction ? (
        <section className="content-grid">
          <div className="summary-card">
            <h2>{selectedFunction.name}</h2>
            <code>{selectedFunction.stableId}</code>
            <div className="meta-row">
              <span>{selectedFunction.repoRelativePath}</span>
              <span>{selectedFunction.startLine}-{selectedFunction.endLine}</span>
            </div>
            <div className="metric-grid">
              <div><strong>{stages.length}</strong><span>stages</span></div>
              <div><strong>{sections.length}</strong><span>sections in selected stage</span></div>
              <div><strong>{selectedStage?.callCount || 0}</strong><span>calls in stage</span></div>
              <div><strong>{selectedStage?.resourceCount || 0}</strong><span>resources in stage</span></div>
            </div>
            <p className="muted">
              В графе сейчас нет отдельных узлов :Stage и :Section. Этот слой строится сервером из Step:FlowArtifact,
              call edges и resource edges.
            </p>
          </div>
          <SectionDetails section={selectedSection} />
        </section>
      ) : (
        <EmptyState>
          Для выбранной Phase нет schema-pinned Function. Сейчас раскрытие разрешено только для Input Intake.
        </EmptyState>
      )}
    </main>
  );
}

function App() {
  return (
    <ApolloProvider client={client}>
      <CascadeScreen />
    </ApolloProvider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
