#!/bin/bash
for i in 1 2 3; do
SYNAPSE_HOME=~/.synapseia-node$i syn start &
echo "Nodo $i iniciado (PID: $!)"
sleep 2
done