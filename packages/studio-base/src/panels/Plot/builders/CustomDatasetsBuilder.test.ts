// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as Comlink from "comlink";
import EventEmitter from "eventemitter3";
import * as _ from "lodash-es";

import { unwrap } from "@foxglove/den/monads";
import { MessageEvent } from "@foxglove/studio";
import parseRosPath from "@foxglove/studio-base/components/MessagePathSyntax/parseRosPath";
import {
  MessageBlock,
  PlayerPresence,
  PlayerState,
  PlayerStateActiveData,
} from "@foxglove/studio-base/players/types";

import { CustomDatasetsBuilder } from "./CustomDatasetsBuilder";
import { CustomDatasetsBuilderImpl } from "./CustomDatasetsBuilderImpl";
import { SeriesConfigKey, SeriesItem } from "./IDatasetsBuilder";
import { PlotPath } from "../config";

class WorkerEndpoint extends EventEmitter {
  #client: Worker;

  public constructor(client: Worker) {
    super();

    this.#client = client;
  }

  public postMessage(msg: unknown): void {
    this.#client.emit("message", {
      data: msg,
    });
  }

  public addEventListener(event: string, fn: () => void): void {
    this.on(event, fn);
  }

  public removeEventListener(event: string, fn: () => void): void {
    this.off(event, fn);
  }
}

class Worker extends EventEmitter {
  #server: WorkerEndpoint;
  public constructor() {
    super();

    this.#server = new WorkerEndpoint(this);
    Comlink.expose(new CustomDatasetsBuilderImpl(), this.#server);
  }

  public postMessage(msg: unknown): void {
    this.#server.emit("message", {
      data: msg,
    });
  }

  public addEventListener(event: string, fn: () => void): void {
    this.on(event, fn);
  }

  public removeEventListener(event: string, fn: () => void): void {
    this.off(event, fn);
  }

  public terminate() {
    // no-op
  }
}

Object.defineProperty(global, "Worker", {
  writable: true,
  value: Worker,
});

function groupByTopic(events: MessageEvent[]): Record<string, MessageEvent[]> {
  return _.groupBy(events, (item) => item.topic);
}

function buildSeriesItems(
  paths: (Partial<PlotPath> & { key?: string; value: string })[],
): SeriesItem[] {
  return paths.map((item, idx) => {
    const parsed = unwrap(parseRosPath(item.value));
    const key = (item.key ?? String(idx)) as SeriesConfigKey;

    return {
      configIndex: idx,
      parsed,
      color: "red",
      contrastColor: "blue",
      enabled: item.enabled ?? true,
      timestampMethod: item.timestampMethod ?? "receiveTime",
      key,
      lineSize: item.lineSize ?? 1,
      messagePath: item.value,
      showLine: item.showLine ?? true,
    } satisfies SeriesItem;
  });
}

function buildPlayerState(
  activeDataOverride?: Partial<PlayerStateActiveData>,
  blocks?: readonly (MessageBlock | undefined)[],
): PlayerState {
  return {
    activeData: {
      messages: [],
      currentTime: { sec: 0, nsec: 0 },
      endTime: { sec: 0, nsec: 0 },
      lastSeekTime: 1,
      topics: [],
      speed: 1,
      isPlaying: false,
      topicStats: new Map(),
      startTime: { sec: 0, nsec: 0 },
      datatypes: new Map(),
      totalBytesReceived: 0,
      ...activeDataOverride,
    },
    capabilities: [],
    presence: PlayerPresence.PRESENT,
    profile: undefined,
    playerId: "1",
    progress: {
      fullyLoadedFractionRanges: [],
      messageCache: {
        blocks: blocks ?? [],
        startTime: { sec: 0, nsec: 0 },
      },
    },
  };
}

describe("CustomDatasetsBuilder", () => {
  it("should dataset from current messages", async () => {
    const builder = new CustomDatasetsBuilder();

    builder.setXPath(parseRosPath("/foo.val"));
    builder.setSeries(
      buildSeriesItems([
        {
          enabled: true,
          timestampMethod: "receiveTime",
          value: "/bar.val",
        },
        {
          enabled: true,
          timestampMethod: "receiveTime",
          value: "/baz.val.@negative",
        },
      ]),
    );

    builder.handlePlayerState(
      buildPlayerState({
        messages: [
          {
            topic: "/foo",
            schemaName: "foo",
            receiveTime: { sec: 0, nsec: 0 },
            sizeInBytes: 0,
            message: {
              val: 0,
            },
          },
          {
            topic: "/foo",
            schemaName: "foo",
            receiveTime: { sec: 0, nsec: 0 },
            sizeInBytes: 0,
            message: {
              val: 1,
            },
          },
          {
            topic: "/bar",
            schemaName: "bar",
            receiveTime: { sec: 0, nsec: 0 },
            sizeInBytes: 0,
            message: {
              val: 0,
            },
          },
        ],
      }),
    );

    builder.handlePlayerState(
      buildPlayerState({
        messages: [
          {
            topic: "/foo",
            schemaName: "foo",
            receiveTime: { sec: 0, nsec: 0 },
            sizeInBytes: 0,
            message: {
              val: 2,
            },
          },
          {
            topic: "/bar",
            schemaName: "bar",
            receiveTime: { sec: 0, nsec: 0 },
            sizeInBytes: 0,
            message: {
              val: 1,
            },
          },
          {
            topic: "/bar",
            schemaName: "bar",
            receiveTime: { sec: 0, nsec: 0 },
            sizeInBytes: 0,
            message: {
              val: 2,
            },
          },
          {
            topic: "/baz",
            schemaName: "baz",
            receiveTime: { sec: 0, nsec: 0 },
            sizeInBytes: 0,
            message: {
              val: 4,
            },
          },
        ],
      }),
    );

    const result = await builder.getViewportDatasets({
      size: { width: 1_000, height: 1_000 },
      bounds: {},
    });

    expect(result).toEqual({
      pathsWithMismatchedDataLengths: new Set(["/baz.val.@negative"]),
      datasets: [
        expect.objectContaining({
          data: [
            { x: 0, y: 0, value: 0 },
            { x: 1, y: 1, value: 1 },
            { x: 2, y: 2, value: 2 },
          ],
          showLine: true,
          pointRadius: 1.2,
          fill: false,
        }),
        expect.objectContaining({
          data: [{ x: 0, y: -4, value: -4 }],
        }),
      ],
    });
  });

  it("should build updates from blocks", async () => {
    const builder = new CustomDatasetsBuilder();

    builder.setXPath(parseRosPath("/foo.val"));
    builder.setSeries(
      buildSeriesItems([
        {
          enabled: true,
          timestampMethod: "receiveTime",
          value: "/bar.val",
          lineSize: 1.0,
        },
        {
          enabled: true,
          timestampMethod: "receiveTime",
          value: "/baz.val.@negative",
          lineSize: 1.0,
        },
      ]),
    );

    const block0 = {
      sizeInBytes: 0,
      messagesByTopic: groupByTopic([
        {
          topic: "/foo",
          schemaName: "foo",
          receiveTime: { sec: 0, nsec: 0 },
          sizeInBytes: 0,
          message: {
            val: 0,
          },
        },
        {
          topic: "/foo",
          schemaName: "foo",
          receiveTime: { sec: 0, nsec: 0 },
          sizeInBytes: 0,
          message: {
            val: 1,
          },
        },
        {
          topic: "/bar",
          schemaName: "bar",
          receiveTime: { sec: 0, nsec: 0 },
          sizeInBytes: 0,
          message: {
            val: 0,
          },
        },
      ]),
    };

    // Baz is empty in the first block
    block0.messagesByTopic["/baz"] = [];

    const block1 = {
      sizeInBytes: 0,
      messagesByTopic: groupByTopic([
        {
          topic: "/foo",
          schemaName: "foo",
          receiveTime: { sec: 0, nsec: 0 },
          sizeInBytes: 0,
          message: {
            val: 2,
          },
        },
        {
          topic: "/bar",
          schemaName: "bar",
          receiveTime: { sec: 0, nsec: 0 },
          sizeInBytes: 0,
          message: {
            val: 1,
          },
        },
        {
          topic: "/bar",
          schemaName: "bar",
          receiveTime: { sec: 0, nsec: 0 },
          sizeInBytes: 0,
          message: {
            val: 2,
          },
        },
        {
          topic: "/baz",
          schemaName: "baz",
          receiveTime: { sec: 0, nsec: 0 },
          sizeInBytes: 0,
          message: {
            val: 4,
          },
        },
      ]),
    };

    builder.handlePlayerState(buildPlayerState({}, [block0]));
    builder.handlePlayerState(buildPlayerState({}, [block0, block1]));

    const result = await builder.getViewportDatasets({
      size: { width: 1_000, height: 1_000 },
      bounds: {},
    });

    expect(result).toEqual({
      pathsWithMismatchedDataLengths: new Set(["/baz.val.@negative"]),
      datasets: [
        expect.objectContaining({
          data: [
            { x: 0, y: 0, value: 0 },
            { x: 1, y: 1, value: 1 },
            { x: 2, y: 2, value: 2 },
          ],
          showLine: true,
          pointRadius: 1.2,
          fill: false,
        }),
        expect.objectContaining({
          data: [{ x: 0, y: -4, value: -4 }],
          showLine: true,
          pointRadius: 1.2,
          fill: false,
        }),
      ],
    });
  });

  it.each(["current", "blocks"] as const)("combines all values from arrays (%s)", async (type) => {
    const builder = new CustomDatasetsBuilder();

    builder.setXPath(parseRosPath("/foo.values[:].val"));
    builder.setSeries(
      buildSeriesItems([
        {
          enabled: true,
          timestampMethod: "receiveTime",
          value: "/bar.values[:].val",
        },
        {
          enabled: true,
          timestampMethod: "receiveTime",
          value: "/baz.values[:].val",
        },
      ]),
    );

    let latestBlocks: MessageBlock[] = [];
    const sendMessages = (messages: MessageEvent[]) => {
      if (type === "current") {
        builder.handlePlayerState(buildPlayerState({ messages }));
      } else {
        latestBlocks = [
          ...latestBlocks,
          {
            sizeInBytes: 0,
            messagesByTopic: {
              "/baz": [],
              ...groupByTopic(messages),
            },
          },
        ];
        builder.handlePlayerState(buildPlayerState({}, latestBlocks));
      }
    };

    sendMessages([
      {
        topic: "/foo",
        schemaName: "foo",
        receiveTime: { sec: 0, nsec: 0 },
        sizeInBytes: 0,
        message: {
          values: [{ val: 0 }, { val: 1 }, { val: 2 }],
        },
      },
      {
        topic: "/foo",
        schemaName: "foo",
        receiveTime: { sec: 0, nsec: 0 },
        sizeInBytes: 0,
        message: {
          values: [{ val: 3 }],
        },
      },
      {
        topic: "/bar",
        schemaName: "bar",
        receiveTime: { sec: 0, nsec: 0 },
        sizeInBytes: 0,
        message: {
          values: [{ val: 10 }, { val: 11 }],
        },
      },
    ]);

    sendMessages([
      {
        topic: "/foo",
        schemaName: "foo",
        receiveTime: { sec: 0, nsec: 0 },
        sizeInBytes: 0,
        message: {
          values: [{ val: 4 }],
        },
      },
      {
        topic: "/bar",
        schemaName: "bar",
        receiveTime: { sec: 0, nsec: 0 },
        sizeInBytes: 0,
        message: {
          values: [{ val: 12 }, { val: 13 }, { val: 14 }],
        },
      },
      {
        topic: "/baz",
        schemaName: "baz",
        receiveTime: { sec: 0, nsec: 0 },
        sizeInBytes: 0,
        message: {
          values: [{ val: 20 }, { val: 21 }],
        },
      },
    ]);

    const result = await builder.getViewportDatasets({
      size: { width: 1_000, height: 1_000 },
      bounds: {},
    });

    expect(result).toEqual({
      pathsWithMismatchedDataLengths: new Set(["/baz.values[:].val"]),
      datasets: [
        expect.objectContaining({
          data: [
            { x: 0, y: 10, value: 10 },
            { x: 1, y: 11, value: 11 },
            { x: 2, y: 12, value: 12 },
            { x: 3, y: 13, value: 13 },
            { x: 4, y: 14, value: 14 },
          ],
          showLine: true,
          pointRadius: 1.2,
          fill: false,
        }),
        expect.objectContaining({
          data: [
            { x: 0, y: 20, value: 20 },
            { x: 1, y: 21, value: 21 },
          ],
        }),
      ],
    });
  });

  it("supports toggling series enabled state", async () => {
    const builder = new CustomDatasetsBuilder();

    builder.setXPath(parseRosPath("/foo.val"));
    builder.setSeries(
      buildSeriesItems([
        {
          enabled: true,
          timestampMethod: "receiveTime",
          value: "/foo.val",
        },
        {
          enabled: true,
          timestampMethod: "receiveTime",
          value: "/bar.val",
        },
      ]),
    );

    builder.handlePlayerState(
      buildPlayerState({
        messages: [
          {
            topic: "/foo",
            schemaName: "foo",
            receiveTime: { sec: 0, nsec: 0 },
            sizeInBytes: 0,
            message: {
              val: 1,
            },
          },
          {
            topic: "/bar",
            schemaName: "bar",
            receiveTime: { sec: 0, nsec: 0 },
            sizeInBytes: 0,
            message: {
              val: 2,
            },
          },
        ],
      }),
    );

    await expect(
      builder.getViewportDatasets({
        size: { width: 1_000, height: 1_000 },
        bounds: {},
      }),
    ).resolves.toEqual({
      pathsWithMismatchedDataLengths: new Set(),
      datasets: [
        expect.objectContaining({
          data: [{ x: 1, y: 1, value: 1 }],
        }),
        expect.objectContaining({
          data: [{ x: 1, y: 2, value: 2 }],
        }),
      ],
    });

    builder.setSeries(
      buildSeriesItems([
        {
          enabled: false,
          timestampMethod: "receiveTime",
          value: "/foo.val",
        },
        {
          enabled: true,
          timestampMethod: "receiveTime",
          value: "/bar.val",
        },
      ]),
    );

    await expect(
      builder.getViewportDatasets({
        size: { width: 1_000, height: 1_000 },
        bounds: {},
      }),
    ).resolves.toEqual({
      pathsWithMismatchedDataLengths: new Set(),
      datasets: [
        expect.objectContaining({
          data: [],
        }),
        expect.objectContaining({
          data: [{ x: 1, y: 2, value: 2 }],
        }),
      ],
    });
  });
});
