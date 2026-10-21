import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { PET, moodLine, petRows } from '../pet.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { VERSION } from '../version.js';
import { Row } from './parts.jsx';

export const PET_WIDTH = 16;
export const WELCOME_HEIGHT = 7;

/** The pet in pixels. While a command runs ("look") it glances from side to side. */
export function Pet({ mood }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mood !== 'look') return;
    const t = setInterval(() => setTick((n) => n + 1), 450);
    return () => clearInterval(t);
  }, [mood]);
  const shown = mood === 'look' && tick % 2 ? 'idle' : mood;
  return petRows(shown).map((segs, i) => <Row key={i} pointer={false} width={PET_WIDTH} segments={segs} />);
}

// The welcome box's line about a newer release, by how far installing it has got.
const UPDATE_LINES = {
  out: (v) => `Hail ${v} is out (you have ${VERSION}). The link is below.`,
  installing: (v) => `Hail ${v} is out; downloading it in the background.`,
  installed: (v) => `Hail ${v} is installed and starts the next time you open Hail.`,
};

/** The box shown when Hail starts, like Claude Code's welcome. Esc or the first command clears it. */
export function Welcome({ mood, data, width, update }) {
  const textW = Math.max(10, width - PET_WIDTH - 7);
  return (
    <Box borderStyle="round" borderColor={theme.accent} width={width} height={WELCOME_HEIGHT} paddingX={1}>
      <Box flexDirection="column" width={PET_WIDTH}>
        <Pet mood={mood} />
      </Box>
      <Box flexDirection="column" marginLeft={2} width={textW}>
        <Text wrap="truncate">
          <Text bold>Welcome to Hail</Text>
          <Text color={theme.dim}>{`  v${VERSION}`}</Text>
        </Text>
        <Text color={theme.dim} wrap="truncate">
          {fit(`${PET.name} the ${PET.kind} here. ${moodLine(mood, data)}`, textW).trimEnd()}
        </Text>
        {update ? (
          <Text color={theme.warn} wrap="truncate">
            {fit(UPDATE_LINES[update.state ?? 'out'](update.latest), textW).trimEnd()}
          </Text>
        ) : (
          <Text> </Text>
        )}
        <Text color={theme.dim} wrap="truncate">
          {fit('/ commands · ! a shell command · ? shortcuts · esc to put this away', textW).trimEnd()}
        </Text>
      </Box>
    </Box>
  );
}
