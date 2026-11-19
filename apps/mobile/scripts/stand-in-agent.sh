#!/bin/bash
# Stand-in agent for the phone app's tests (not a real agent). PI Lab starts
# it in place of the "test-waiting" catalog agent (see test-lab.mjs). It
# prints a question that PI Lab's screen check reads as "waiting for input",
# reads the answer, works for a few seconds, then shows a normal prompt
# (PI Lab reads that as "finished its turn") and reads the next message, after
# which it asks the next question. PI Lab passes its own arguments first and
# the prompt last; only the prompt is used.
task="${*: -1}"
echo "Stand-in agent (not a real agent). Task: ${task}"
step=1
while true; do
  echo "Question ${step}: which option should I use? (yes/no)"
  IFS= read -r answer || exit 0
  # Clear the screen, so the answered question is not read as a new one.
  printf '\033[2J\033[H'
  echo "Got answer: ${answer}"
  echo "Working on step ${step}..."
  sleep 3
  echo "Finished step ${step}."
  printf '❯ '
  IFS= read -r message || exit 0
  echo "Got message: ${message}"
  step=$((step + 1))
done
