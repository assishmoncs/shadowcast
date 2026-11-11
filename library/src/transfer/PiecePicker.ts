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

  // assetId -> totalChunks known for the asset
  private assetTotalChunks: Map<string, number> = new Map();

  constructor(private readonly assignmentTimeoutMs: number = 6000) {}

  registerPeerChunks(assetId: string, peerId: string, chunkIndices: number[], totalChunks?: number): void {
    if (!this.swarmAvailability.has(assetId)) {
      this.swarmAvailability.set(assetId, new Map());
    }

    if (typeof totalChunks === 'number' && totalChunks > 0) {
      this.assetTotalChunks.set(assetId, totalChunks);
    }

    const peerMap = this.swarmAvailability.get(assetId)!;
    peerMap.set(peerId, new Set(chunkIndices));
  }

  unregisterPeer(peerId: string): Map<string, number[]> {
    const unassignedPerAsset: Map<string, number[]> = new Map();

    // Clean up availability
    for (const [, peerMap] of this.swarmAvailability.entries()) {
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
    if (totalChunks <= 0 || availablePeers.length === 0) {
      return [];
    }

    this.assetTotalChunks.set(assetId, totalChunks);
    const peerMap = this.swarmAvailability.get(assetId);
    const validPeers = availablePeers.filter((pid) => !peerMap || peerMap.has(pid));

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
      // If unassigned, assigned to a disconnected peer, or timed out, schedule it
      if (
        !current ||
        !validPeers.includes(current.peerId) ||
        now - current.assignedAt > this.assignmentTimeoutMs
      ) {
        neededChunks.push(i);
      }
    }

    if (neededChunks.length === 0) {
      return [];
    }

    // Track current load per peer to distribute pieces evenly across capable peers
    const result: Map<string, number[]> = new Map();
    const peerLoad: Map<string, number> = new Map();
    for (const pid of validPeers) {
      result.set(pid, []);
      peerLoad.set(pid, 0);
    }

    for (const [, info] of assignmentsMap.entries()) {
      if (peerLoad.has(info.peerId)) {
        peerLoad.set(info.peerId, peerLoad.get(info.peerId)! + 1);
      }
    }

    for (let i = 0; i < neededChunks.length; i++) {
      const chunkIdx = neededChunks[i];

      // Filter to peers that actually possess this chunk index
      const capablePeers = peerMap
        ? validPeers.filter((pid) => peerMap.get(pid)?.has(chunkIdx))
        : validPeers;

      if (capablePeers.length === 0) {
        continue;
      }

      // Select capable peer with minimum assigned load
      let chosenPeer = capablePeers[0];
      let minLoad = peerLoad.get(chosenPeer) ?? 0;
      for (let j = 1; j < capablePeers.length; j++) {
        const candidate = capablePeers[j];
        const load = peerLoad.get(candidate) ?? 0;
        if (load < minLoad) {
          minLoad = load;
          chosenPeer = candidate;
        }
      }

      result.get(chosenPeer)!.push(chunkIdx);
      peerLoad.set(chosenPeer, minLoad + 1);
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

  getTotalChunks(assetId: string): number | undefined {
    return this.assetTotalChunks.get(assetId);
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
    this.assetTotalChunks.delete(assetId);
  }

  clear(): void {
    this.swarmAvailability.clear();
    this.activeAssignments.clear();
    this.assetTotalChunks.clear();
  }
}
