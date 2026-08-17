/**
 * ShadowCast - Swarm Piece Picker & Parallel Download Scheduler
 */

export interface PeerAvailability {
  peerId: string;
  availableChunks: Set<number>;
}

export interface PieceAssignment {
  peerId: string;
  indices: number[];
}

export class PiecePicker {
  // assetId -> peerId -> Set of chunk indices available on that peer
  private swarmAvailability: Map<string, Map<string, Set<number>>> = new Map();

  // assetId -> chunkIndex -> peerId currently assigned to download this piece
  private activeAssignments: Map<string, Map<number, { peerId: string; assignedAt: number }>> =
    new Map();

  registerPeerChunks(assetId: string, peerId: string, chunkIndices: number[]): void {
    if (!this.swarmAvailability.has(assetId)) {
      this.swarmAvailability.set(assetId, new Map());
    }

    const peerMap = this.swarmAvailability.get(assetId)!;
    peerMap.set(peerId, new Set(chunkIndices));
  }

  unregisterPeer(peerId: string): Map<string, number[]> {
    const unassignedPerAsset: Map<string, number[]> = new Map();

    // Clean up availability
    for (const [assetId, peerMap] of this.swarmAvailability.entries()) {
      peerMap.delete(peerId);
    }

    // Identify chunks that were assigned to the disconnected peer
    for (const [assetId, assignments] of this.activeAssignments.entries()) {
      const reassignList: number[] = [];
      for (const [chunkIdx, info] of assignments.entries()) {
        if (info.peerId === peerId) {
          reassignList.push(chunkIdx);
          assignments.delete(chunkIdx);
        }
      }
      if (reassignList.length > 0) {
        unassignedPerAsset.set(assetId, reassignList);
      }
    }

    return unassignedPerAsset;
  }

  planPieceRequests(
    assetId: string,
    totalChunks: number,
    alreadyReceived: Set<number>,
    availablePeers: string[]
  ): PieceAssignment[] {
    const peerMap = this.swarmAvailability.get(assetId);
    const validPeers = availablePeers.filter(
      (pid) => !peerMap || peerMap.has(pid)
    );

    if (validPeers.length === 0) {
      return [];
    }

    if (!this.activeAssignments.has(assetId)) {
      this.activeAssignments.set(assetId, new Map());
    }
    const assignmentsMap = this.activeAssignments.get(assetId)!;

    // Determine chunks still needing download
    const neededChunks: number[] = [];
    const now = Date.now();
    for (let i = 0; i < totalChunks; i++) {
      if (alreadyReceived.has(i)) {
        assignmentsMap.delete(i);
        continue;
      }

      const current = assignmentsMap.get(i);
      // If unassigned or timed out after 6 seconds, schedule it
      if (!current || now - current.assignedAt > 6000) {
        neededChunks.push(i);
      }
    }

    if (neededChunks.length === 0) {
      return [];
    }

    // Partition needed chunks evenly across valid peers
    const result: Map<string, number[]> = new Map();
    for (const pid of validPeers) {
      result.set(pid, []);
    }

    for (let i = 0; i < neededChunks.length; i++) {
      const chunkIdx = neededChunks[i];
      // Pick next peer round-robin
      const chosenPeer = validPeers[i % validPeers.length];
      result.get(chosenPeer)!.push(chunkIdx);
      assignmentsMap.set(chunkIdx, { peerId: chosenPeer, assignedAt: now });
    }

    const assignments: PieceAssignment[] = [];
    for (const [peerId, indices] of result.entries()) {
      if (indices.length > 0) {
        assignments.push({ peerId, indices });
      }
    }

    return assignments;
  }

  markChunkCompleted(assetId: string, chunkIndex: number): void {
    const assignmentsMap = this.activeAssignments.get(assetId);
    if (assignmentsMap) {
      assignmentsMap.delete(chunkIndex);
    }
  }

  clearAsset(assetId: string): void {
    this.swarmAvailability.delete(assetId);
    this.activeAssignments.delete(assetId);
  }

  clear(): void {
    this.swarmAvailability.clear();
    this.activeAssignments.clear();
  }
}
