//const name = input.trim().slice(1).split(/\s/)[0];
//if 
  (activeRemote.isRemoteMode && 
      !(isSlashCommand && 
          commands.find(c => 
                          { return isCommandEnabled(c) &&
                              (c.name === name || c.aliases?.includes(name!) || getCommandName(c) === name);
                          }
                        )?.type === 'local-jsx'
        )
  )

(createCommandInputMessage
    (formatCommandInputTags
        (getCommandName(matchingCommand), 
         commandArgs
        )
    ), 
    createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(result)}</${LOCAL_COMMAND_STDOUT_TAG}>`)
);

if (feature('COMMIT_ATTRIBUTION')) {
        setAppState(prev => ({
          ...prev,
          attribution: incrementPromptCount(prev.attribution, snapshot => {
            void recordAttributionSnapshot(snapshot).catch(error => {
              logForDebugging(`Attribution: Failed to save snapshot: ${error}`);
            });
          })
        }));
      }
newMessages.push(
  createCommandInputMessage(
    formatCommandInputTags(
      getCommandName(matchingCommand), 
      commandArgs
    )
  ), 
  createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(result)}</${LOCAL_COMMAND_STDOUT_TAG}>`)
);
              
                