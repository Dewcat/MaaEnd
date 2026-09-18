import assert from "node:assert/strict";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {parseJsonc, readJsonc} from "../jsonc.mjs";
import {DELIVERY_JOB_FILL_ITEM_PRIORITY_COUNT, deliveryJobDepots, deliveryJobRegions} from "./model.mjs";

const AUTO_DELIVERY_NAVIGATE_NODES = [
    "AutoDeliveryNavigateDepot",
    "AutoDeliveryNavigateDestination",
];

function readGeneratedPipeline(...segments) {
    return readJsonc(new URL(`../../../assets/resource/pipeline/${segments.join("/")}`, import.meta.url));
}

test("DeliveryJobs JSONC reader accepts comments and rejects malformed input", () => {
    assert.deepEqual(parseJsonc('{\n  // comment\n  "value": 1,\n}', "inline fixture"), {value: 1});
    assert.deepEqual(parseJsonc('\uFEFF{"ok": true}', "BOM fixture"), {ok: true});
    assert.throws(() => parseJsonc('{\uFEFF"ok": true}', "misplaced BOM fixture"), /InvalidSymbol at offset 1/);
    assert.throws(() => parseJsonc('{"value": }', "invalid fixture"), /无法解析 JSONC invalid fixture/);
});

function readAdbPipeline(...segments) {
    return readJsonc(new URL(`../../../assets/resource_adb/pipeline/${segments.join("/")}`, import.meta.url));
}

function readGeneratedTask() {
    return readJsonc(new URL("../../../assets/tasks/DeliveryJobs.json", import.meta.url));
}

function readSeizeDeliveryJobsTask() {
    return readJsonc(new URL("../../../assets/tasks/SeizeDeliveryJobs.json", import.meta.url));
}

function getDepotModeContext(task, depot) {
    const option = task.option[depot.Id];
    return {
        option,
        byName: Object.fromEntries(
            option.cases.map((mode) => [
                mode.name,
                mode,
            ]),
        ),
        deliveryNode: `DeliveryJobsEnter${depot.Id}DeliveryJob`,
        cargoNode: `DeliveryJobsEnter${depot.Id}Cargo`,
        cargoCheckNode: `DeliveryJobsCheck${depot.Id}Cargo`,
        ongoingNode: `DeliveryJobsOngoingDeliveryFor${depot.Id}`,
    };
}

test("DeliveryJobs model has unique regions and depots", () => {
    assert.equal(new Set(deliveryJobRegions.map((region) => region.Id)).size, deliveryJobRegions.length);
    assert.equal(new Set(deliveryJobDepots.map((depot) => depot.Id)).size, deliveryJobDepots.length);
    assert.deepEqual(
        deliveryJobRegions.flatMap((region) => region.Depots),
        deliveryJobDepots.map((depot) => depot.Id),
    );
    assert.deepEqual(
        deliveryJobRegions.map((region) => region.Id),
        [
            "ValleyIV",
            "Wuling",
        ],
    );
    assert.deepEqual(
        deliveryJobDepots.map((depot) => depot.Id),
        [
            "OriginiumSciencePark",
            "OriginLodespring",
            "PowerPlateau",
            "WulingCity",
            "TestArea",
        ],
    );
    const iconRecognitionItems = readJsonc(
        new URL("../../../assets/data/IconRecognition/recognition_items.json", import.meta.url),
    );
    for (const region of deliveryJobRegions) {
        assert.ok(region.Depots.length > 0, `${region.Id} must contain at least one depot`);
        assert.ok(region.FillItems.some((item) => item.Id === region.DefaultFillItem));
        assert.ok(region.FillItems.length > 0, `${region.Id} must contain at least one fill item`);
        for (const item of region.FillItems) {
            const catalogEntry = iconRecognitionItems[item.ItemId];
            assert.ok(catalogEntry, `${region.Id} item ${item.ItemId} missing from IconRecognition catalog`);
            assert.equal(item.RecheckFilter, `${catalogEntry.storageKind}:${catalogEntry.categoryType}`);
            assert.equal(item.Label, `$iconRecognition.name.${item.ItemId}`);
        }
    }
    assert.deepEqual(
        deliveryJobDepots.filter((depot) => depot.AutoDeliverySupported).map((depot) => depot.Id),
        [
            "OriginiumSciencePark",
            "OriginLodespring",
            "PowerPlateau",
            "WulingCity",
            "TestArea",
        ],
    );
});

test("DeliveryJobs offers transferable equipment components in Valley IV", () => {
    const valleyIV = deliveryJobRegions.find((region) => region.Id === "ValleyIV");
    assert.ok(valleyIV);
    const itemIds = new Set(valleyIV.FillItems.map((item) => item.Id));
    for (const itemId of [
        "item_equip_script_4",
        "item_equip_script_4_1",
        "item_equip_script_4_2",
        "item_equip_script_4_3",
    ]) {
        assert.ok(itemIds.has(itemId), `${itemId} must be available after transfer to Valley IV`);
    }
    assert.equal(itemIds.has("item_fertilize_1"), false);
    assert.equal(itemIds.has("item_fertilize_2"), false);
});

test("DeliveryJobs generated region loops cover every depot in stable order", () => {
    for (const region of deliveryJobRegions) {
        const pipeline = readGeneratedPipeline("DeliveryJobs", "Region", `${region.Id}.json`);
        assert.deepEqual(pipeline[`DeliveryJobs${region.Id}Loop`].next, [
            ...region.Depots.map((depotId) => `[JumpBack]DeliveryJobsEnter${depotId}DeliveryJob`),
            ...region.Depots.map((depotId) => `[JumpBack]DeliveryJobsEnter${depotId}Cargo`),
            "DeliveryJobsLoop",
            "[JumpBack]SceneEnterMenuRegionalDevelopment",
        ]);
        assert.equal(pipeline[`DeliveryJobs${region.Id}Loop`].max_hit, undefined);
        assert.deepEqual(pipeline[`DeliveryJobsIn${region.Id}LocalDepotNode`].all_of, [
            "InLocalDepotNode",
            `DeliveryJobsCheckLocalDepotNode${region.Depots[0]}Text`,
        ]);
        assert.deepEqual(pipeline[`DeliveryJobsSelectPriorityItems${region.Id}`].next, [
            "DeliveryJobsCargoFillToMax",
        ]);
    }
});

test("DeliveryJobs leaves locked depot handling to SceneManager", () => {
    const corePipeline = readGeneratedPipeline("DeliveryJobs.json");
    assert.equal(corePipeline.DeliveryJobsDepotLocked, undefined);

    for (const region of deliveryJobRegions) {
        const pipeline = readGeneratedPipeline("DeliveryJobs", "Region", `${region.Id}.json`);
        assert.deepEqual(pipeline[`DeliveryJobs${region.Id}`].next, [
            `DeliveryJobs${region.Id}Loop`,
        ]);
    }
});

test("DeliveryJobs generated depot nodes enter the shared transfer and cargo flows", () => {
    for (const depot of deliveryJobDepots) {
        const pipeline = readGeneratedPipeline("DeliveryJobs", "Depot", depot.RegionId, `${depot.Id}.json`);
        assert.deepEqual(pipeline[`DeliveryJobsEnter${depot.Id}DeliveryJob`].anchor, {
            DeliveryJobsReturnToDepotNode: "InLocalDepotNode",
        });
        assert.deepEqual(pipeline[`DeliveryJobsEnter${depot.Id}DeliveryJob`].next, [
            "DeliveryJobsClickTransferJob",
        ]);
        assert.equal(pipeline[`DeliveryJobsEnter${depot.Id}DeliveryJob`].max_hit, 1);
        assert.equal(pipeline[`DeliveryJobsEnter${depot.Id}Cargo`].max_hit, 1);
        assert.deepEqual(pipeline[`DeliveryJobsEnter${depot.Id}Cargo`].anchor, {
            DeliveryJobsSelectPriorityItems: `DeliveryJobsSelectPriorityItems${depot.RegionId}`,
            DeliveryJobsRedistributionBidAction: "DeliveryJobsRedistributionBidNextStep",
            DeliveryJobsAfterAcceptJob: "DeliveryJobsDeliverQuickly",
            DeliveryJobsGoToDepot: depot.DepotScene,
            DeliveryJobsReturnToDepotNode: depot.DepotScene,
        });
        assert.deepEqual(pipeline[`DeliveryJobsOngoingDeliveryFor${depot.Id}`].next, [
            "DeliveryJobsSkipOngoingDelivery",
        ]);
        assert.equal(pipeline[`DeliveryJobsOngoingDeliveryFor${depot.Id}`].pre_delay, 0);
        assert.deepEqual(pipeline[`DeliveryJobsOngoingDeliveryFor${depot.Id}`].anchor, {
            DeliveryJobsReturnToDepotNode: depot.DepotScene,
        });
        assert.deepEqual(pipeline[`DeliveryJobsEnter${depot.Id}Cargo`].next, [
            "DeliveryJobsPackCargo",
        ]);
        assert.deepEqual(pipeline[`DeliveryJobsReturnAndTransfer${depot.Id}`].custom_action_param.sub, [
            depot.DepotScene,
        ]);
        assert.deepEqual(pipeline[`DeliveryJobsEnter${depot.Id}PriceDeliveryJob`].next, [
            "DeliveryJobsClickTransferJob",
        ]);
        assert.deepEqual(pipeline[`DeliveryJobsEnter${depot.Id}PriceDeliveryJob`].anchor, {
            DeliveryJobsReturnToDepotNode: "InLocalDepotNode",
        });
        assert.equal(pipeline[`DeliveryJobsOpenOngoingAutoDelivery${depot.Id}`], undefined);
        assert.equal(pipeline[`DeliveryJobsReturnAndView${depot.Id}CurrentJob`], undefined);
        assert.equal(pipeline[`DeliveryJobsView${depot.Id}CurrentJob`], undefined);
        assert.equal(pipeline[`DeliveryJobsStartAutoDelivery${depot.Id}`], undefined);
        assert.equal(pipeline[`DeliveryJobsConfigureAutoDelivery${depot.Id}`], undefined);
    }
});

test("DeliveryJobs returns to the current depot node through the DeliveryJobsReturnToDepotNode anchor", () => {
    const transfer = readGeneratedPipeline("DeliveryJobs", "TransferJob.json");
    const cargo = readGeneratedPipeline("DeliveryJobs", "PackCargo.json");
    const autoDelivery = readGeneratedPipeline("DeliveryJobs", "AutoDelivery.json");
    assert.deepEqual(transfer.DeliveryJobsConfirmTaskTransfer.next, [
        "[Anchor]DeliveryJobsReturnToDepotNode",
    ]);
    assert.deepEqual(cargo.DeliveryJobsSkipOngoingDelivery.next, [
        "[Anchor]DeliveryJobsReturnToDepotNode",
    ]);
    // 共享步骤不声明该锚点
    assert.equal(transfer.DeliveryJobsTransferOngoingJob.anchor, undefined);
    assert.equal(transfer.DeliveryJobsClickTransferJob.anchor, undefined);
    assert.equal(autoDelivery.DeliveryJobsDeliverByAutoDelivery.anchor, undefined);
    for (const depot of deliveryJobDepots) {
        const pipeline = readGeneratedPipeline("DeliveryJobs", "Depot", depot.RegionId, `${depot.Id}.json`);
        // 仓储节点界面发起的转交落在 InLocalDepotNode
        for (const entry of [
            `DeliveryJobsEnter${depot.Id}DeliveryJob`,
            `DeliveryJobsEnter${depot.Id}PriceDeliveryJob`,
        ]) {
            assert.equal(pipeline[entry].anchor.DeliveryJobsReturnToDepotNode, "InLocalDepotNode");
        }
        // 任务界面发起时落在本仓储节点的场景节点
        for (const entry of [
            `DeliveryJobsEnter${depot.Id}Cargo`,
            `DeliveryJobsOngoingDeliveryFor${depot.Id}`,
            `DeliveryJobsAutoDelivery${depot.Id}`,
        ]) {
            assert.equal(pipeline[entry].anchor.DeliveryJobsReturnToDepotNode, depot.DepotScene);
        }
    }
});

test("DeliveryJobs generated quote nodes compare the threshold and route the selected action", () => {
    for (const depot of deliveryJobDepots) {
        const pipeline = readGeneratedPipeline("DeliveryJobs", "Depot", depot.RegionId, `${depot.Id}.json`);
        assert.deepEqual(pipeline[`DeliveryJobsDecide${depot.Id}Quote`].next, [
            `DeliveryJobs${depot.Id}QuoteAtLeastMinimum`,
            `DeliveryJobs${depot.Id}QuoteBelowMinimum`,
            "DeliveryJobsBidPriceRecognitionFailed",
        ]);
        assert.deepEqual(pipeline[`DeliveryJobs${depot.Id}QuoteAtLeastMinimum`].custom_recognition_param, {
            expression: "{DeliveryJobsSelectedBidPrice}>=119000",
        });
        assert.deepEqual(pipeline[`DeliveryJobs${depot.Id}QuoteBelowMinimum`].custom_recognition_param, {
            expression: "{DeliveryJobsSelectedBidPrice}<119000",
        });
        assert.deepEqual(pipeline[`DeliveryJobs${depot.Id}QuoteAtLeastMinimum`].anchor, {
            DeliveryJobsQuoteAction: "DeliveryJobsQuoteTransferJob",
            DeliveryJobsGoToDepot: `DeliveryJobsReturnAndTransfer${depot.Id}`,
        });
        assert.deepEqual(pipeline[`DeliveryJobs${depot.Id}QuoteBelowMinimum`].anchor, {
            DeliveryJobsQuoteAction: "DeliveryJobsQuoteAcceptJobOnly",
            DeliveryJobsGoToDepot: depot.DepotScene,
        });
        for (const comparison of [
            "AtLeastMinimum",
            "BelowMinimum",
        ]) {
            assert.deepEqual(pipeline[`DeliveryJobs${depot.Id}Quote${comparison}`].next, [
                "[Anchor]DeliveryJobsQuoteAction",
            ]);
        }
    }
});

test("DeliveryJobs task registers region switches and the shared packing option", () => {
    const task = readGeneratedTask();
    assert.deepEqual(task.task[0].option, [
        ...deliveryJobRegions.map((region) => region.Id),
        "PackCargoSelectItem",
        "DeliveryJobsAutoDeliveryPreferZipline",
        "DeliveryJobsOngoingDeliveryFallback",
    ]);
    assert.equal(task.option.DeliveryJobsAcceptJobOnly, undefined);
    assert.equal(task.option.DeliveryJobsPackCargoOnly, undefined);
    assert.equal(task.option.DeliveryJobsAutoDeliveryRiskAcknowledgement, undefined);
    assert.equal(task.option.DeliveryJobsAutoDeliveryGuard, undefined);
});

test("SeizeDeliveryJobs applies the shared zipline preference to AutoDelivery navigation nodes", () => {
    const task = readSeizeDeliveryJobsTask();
    const walkCase = task.option.SeizeDeliveryJobsPostProcessing.cases.find((itemCase) => itemCase.name === "TeleWalk");
    const fullyAutomaticCase = task.option.SeizeDeliveryJobsPostProcessing.cases.find(
        (itemCase) => itemCase.name === "TeleWalkFetchDeliver",
    );
    assert.ok(walkCase.option.includes("SeizeDeliveryJobsPostDeparturePreferZipline"));
    assert.ok(fullyAutomaticCase.option.includes("SeizeDeliveryJobsPostDeparturePreferZipline"));

    const ziplineOption = task.option.SeizeDeliveryJobsPostDeparturePreferZipline;
    assert.equal(ziplineOption.default_case, "No");
    for (const [
        index,
        zip,
    ] of [
        false,
        true,
    ].entries()) {
        const itemCase = ziplineOption.cases[index];
        assert.deepEqual(Object.keys(itemCase.pipeline_override), AUTO_DELIVERY_NAVIGATE_NODES);
        for (const node of AUTO_DELIVERY_NAVIGATE_NODES) {
            assert.deepEqual(itemCase.pipeline_override[node].attach, {
                zip,
            });
        }
    }
});

test("DeliveryJobs packing item options inject IconRecognition item ids", () => {
    const task = readGeneratedTask();
    const enabledCase = task.option.PackCargoSelectItem.cases.find((itemCase) => itemCase.name === "Yes");
    assert.deepEqual(
        enabledCase.option,
        deliveryJobRegions.map((region) => `FillItemPriorities${region.Id}`),
    );
    assert.deepEqual(enabledCase.pipeline_override.DeliveryJobsSelectTypeOfGoodsToPackNextStep.next, [
        "[Anchor]DeliveryJobsSelectPriorityItems",
    ]);

    for (const region of deliveryJobRegions) {
        const regionOption = task.option[`FillItemPriorities${region.Id}`];
        assert.equal(regionOption.type, "switch");
        assert.equal(regionOption.label, `$global.region.${region.Id}`);
        assert.equal(regionOption.description, "$task.DeliveryJobs.FillItemPriorityRegionDescription");
        assert.equal(regionOption.default_case, "Yes");
        const regionEnabledCase = regionOption.cases.find((itemCase) => itemCase.name === "Yes");
        assert.deepEqual(
            regionEnabledCase.option,
            Array.from(
                {length: DELIVERY_JOB_FILL_ITEM_PRIORITY_COUNT},
                (_, index) => `WhatToFill${region.Id}Priority${index + 1}`,
            ),
        );
        assert.deepEqual(regionEnabledCase.pipeline_override[`DeliveryJobsSelectPriorityItems${region.Id}`].next, [
            `DeliveryJobsStartFill${region.Id}Priority1`,
        ]);
        for (let priority = 1; priority <= DELIVERY_JOB_FILL_ITEM_PRIORITY_COUNT; priority += 1) {
            const optionName = `WhatToFill${region.Id}Priority${priority}`;
            const option = task.option[optionName];
            assert.equal(option.type, "select");
            assert.equal(option.label, `$task.DeliveryJobs.WhatToFill${region.Id}Priority${priority}`);
            assert.equal(option.cases.length, region.FillItems.length + (priority === 1 ? 0 : 1));
            assert.equal(option.default_case, priority === 1 ? region.DefaultFillItem : "None");
            if (priority > 1) {
                assert.deepEqual(option.cases[0], {
                    name: "None",
                    label: "$task.DeliveryJobs.FillItemPriorityNone",
                });
            }
            const itemCases = priority === 1 ? option.cases : option.cases.slice(1);
            for (const [
                index,
                item,
            ] of region.FillItems.entries()) {
                const optionCase = itemCases[index];
                assert.equal(optionCase.name, item.Id);
                assert.equal(optionCase.label, item.Label);
                assert.equal(
                    optionCase.pipeline_override[`DeliveryJobsStartFill${region.Id}Priority${priority}`].enabled,
                    true,
                );
                const selectionOverride =
                    optionCase.pipeline_override[`DeliveryJobsSelectItemToFill${region.Id}Priority${priority}`];
                assert.equal(selectionOverride.enabled, true);
                assert.deepEqual(selectionOverride.custom_recognition_param, {
                    grid_type: "shipment",
                    item_ids: [
                        item.ItemId,
                    ],
                    item_recheck_filters: [
                        item.RecheckFilter,
                    ],
                    deduplicate: true,
                });
            }
        }
    }
});

test("DeliveryJobs task adds automatic delivery as an independent supported-depot mode", () => {
    const task = readGeneratedTask();
    for (const depot of deliveryJobDepots) {
        const {option} = getDepotModeContext(task, depot);
        assert.equal(option.type, "select");
        assert.equal(option.default_case, "Transfer");
        assert.deepEqual(
            option.cases.map((mode) => mode.name),
            [
                "Transfer",
                ...(depot.AutoDeliverySupported
                    ? [
                          "AutoDelivery",
                      ]
                    : []),
                "ByQuote",
                "AcceptJobOnly",
                "PackCargoOnly",
                "Disabled",
            ],
        );
    }
});

test("DeliveryJobs derives automatic delivery support from delivery destinations", () => {
    const catalog = readJsonc(new URL("../data/delivery_destinations.json", import.meta.url));
    const depotIdsWithDestination = new Set(
        catalog.destinations.map((destination) => destination.depot_id).filter(Boolean),
    );
    for (const depot of deliveryJobDepots) {
        assert.equal(
            depot.AutoDeliverySupported,
            depotIdsWithDestination.has(depot.GameId),
            `${depot.Id} 的自动送货支持标记与 delivery_destinations.json 不一致`,
        );
    }
});

test("DeliveryJobs ongoing delivery area names map back to the owning depot id", () => {
    const catalog = readJsonc(new URL("../data/delivery_destinations.json", import.meta.url));
    const areaNamesByDepot = new Map();
    for (const destination of catalog.destinations) {
        if (!destination.depot_id) {
            continue;
        }
        const names = areaNamesByDepot.get(destination.depot_id) ?? new Set();
        names.add(destination.area.en_us);
        areaNamesByDepot.set(destination.depot_id, names);
    }

    for (const depot of deliveryJobDepots) {
        const areaNames = areaNamesByDepot.get(depot.GameId);
        if (areaNames === undefined) {
            continue;
        }
        // Go 侧 area.ID 由 en_us 区域名去掉非字母数字得到，和生成器的 MaaEnd ID 规则一致；
        // DeliveryJobsResolveOngoingDepotAction 用它拼分派节点名，两边必须落在同一个字符串上。
        for (const areaName of areaNames) {
            assert.equal(areaName.replace(/[^A-Za-z0-9]+/g, ""), depot.Id);
        }
    }
});

test("DeliveryJobs dispatches the ongoing delivery job through the owning depot mode", () => {
    const task = readGeneratedTask();
    for (const depot of deliveryJobDepots) {
        const {byName, ongoingNode} = getDepotModeContext(task, depot);
        const expectedNext = {
            Transfer: "DeliveryJobsTransferOngoingJob",
            AutoDelivery: `DeliveryJobsAutoDelivery${depot.Id}`,
            ByQuote: "DeliveryJobsSkipOngoingDelivery",
            AcceptJobOnly: "DeliveryJobsSkipOngoingDelivery",
            PackCargoOnly: "DeliveryJobsSkipOngoingDelivery",
        };

        for (const [
            mode,
            next,
        ] of Object.entries(expectedNext)) {
            const modeCase = byName[mode];
            if (modeCase === undefined) {
                assert.equal(depot.AutoDeliverySupported, false);
                continue;
            }
            assert.deepEqual(modeCase.pipeline_override[ongoingNode].next, [
                next,
            ]);
        }
    }
});

test("DeliveryJobs ordinary depot modes override delivery and cargo behavior", () => {
    const task = readGeneratedTask();
    for (const depot of deliveryJobDepots) {
        const {byName, deliveryNode, cargoNode, cargoCheckNode, ongoingNode} = getDepotModeContext(task, depot);
        assert.equal(byName.Transfer.pipeline_override[deliveryNode].enabled, true);
        assert.equal(
            byName.Transfer.pipeline_override[cargoNode].anchor.DeliveryJobsRedistributionBidAction,
            "DeliveryJobsRedistributionBidNextStep",
        );
        assert.deepEqual(byName.Transfer.pipeline_override[ongoingNode].next, [
            "DeliveryJobsTransferOngoingJob",
        ]);
        assert.equal(byName.Transfer.pipeline_override[cargoNode].anchor.DeliveryJobsGoToDepot, depot.DepotScene);

        assert.equal(byName.PackCargoOnly.pipeline_override[deliveryNode].enabled, false);
        assert.equal(
            byName.PackCargoOnly.pipeline_override[cargoNode].anchor.DeliveryJobsRedistributionBidAction,
            "DeliveryJobsBackToDepotFromBid",
        );
        assert.deepEqual(byName.PackCargoOnly.pipeline_override[ongoingNode].next, [
            "DeliveryJobsSkipOngoingDelivery",
        ]);
        assert.equal(byName.PackCargoOnly.pipeline_override[cargoNode].anchor.DeliveryJobsGoToDepot, depot.DepotScene);
        assert.equal(byName.PackCargoOnly.pipeline_override[cargoCheckNode].expected.includes("查看报价"), false);

        assert.equal(byName.AcceptJobOnly.pipeline_override[deliveryNode].enabled, false);
        assert.deepEqual(byName.AcceptJobOnly.pipeline_override[ongoingNode].next, [
            "DeliveryJobsSkipOngoingDelivery",
        ]);
        assert.equal(byName.AcceptJobOnly.pipeline_override[cargoNode].anchor.DeliveryJobsGoToDepot, depot.DepotScene);
        assert.equal(byName.AcceptJobOnly.option, undefined);

        assert.deepEqual(byName.Disabled.pipeline_override, {
            [deliveryNode]: {
                enabled: false,
            },
            [cargoNode]: {
                enabled: false,
            },
        });
    }
});

test("DeliveryJobs exposes automatic delivery for supported depots with shared safety options", () => {
    const task = readGeneratedTask();

    for (const depot of deliveryJobDepots) {
        const {byName} = getDepotModeContext(task, depot);
        if (!depot.AutoDeliverySupported) {
            assert.equal(byName.AutoDelivery, undefined);
            continue;
        }

        const ordinaryAutoOverride = byName.AutoDelivery.pipeline_override;
        const deliveryNode = `DeliveryJobsEnter${depot.Id}DeliveryJob`;
        const cargoNode = `DeliveryJobsEnter${depot.Id}Cargo`;
        const autoDelivery = `DeliveryJobsAutoDelivery${depot.Id}`;
        assert.deepEqual(ordinaryAutoOverride[deliveryNode], {
            enabled: true,
            next: [autoDelivery],
        });
        assert.deepEqual(ordinaryAutoOverride[cargoNode].anchor, {
            DeliveryJobsSelectPriorityItems: `DeliveryJobsSelectPriorityItems${depot.RegionId}`,
            DeliveryJobsRedistributionBidAction: "DeliveryJobsRedistributionBidNextStep",
            DeliveryJobsAfterAcceptJob: "DeliveryJobsDeliverQuickly",
            DeliveryJobsGoToDepot: autoDelivery,
            DeliveryJobsReturnToDepotNode: depot.DepotScene,
        });
        assert.deepEqual(ordinaryAutoOverride[`DeliveryJobsOngoingDeliveryFor${depot.Id}`].next, [
            autoDelivery,
        ]);
        assert.equal(ordinaryAutoOverride.AutoDeliveryOpenCurrentJobDetail, undefined);
        assert.equal(ordinaryAutoOverride.AutoDeliveryPostDepartureEntry, undefined);
        assert.equal(ordinaryAutoOverride.SeizeDeliveryJobsPostProcessingEntry, undefined);

        for (const comparison of [
            "AtLeastMinimum",
            "BelowMinimum",
        ]) {
            const quoteAutoOverride = task.option[`DeliveryJobs${comparison}QuoteAction${depot.Id}`].cases.find(
                (item) => item.name === "AutoDelivery",
            ).pipeline_override;
            assert.deepEqual(quoteAutoOverride, {
                [`DeliveryJobs${depot.Id}Quote${comparison}`]: {
                    anchor: {
                        DeliveryJobsQuoteAction: "DeliveryJobsQuoteAcceptJobOnly",
                        DeliveryJobsGoToDepot: autoDelivery,
                    },
                },
            });
            assert.equal(quoteAutoOverride[deliveryNode], undefined);
            assert.equal(quoteAutoOverride[cargoNode], undefined);
        }
    }

    assert.equal(task.option.DeliveryJobsAutoDeliveryPreferZipline.controller, undefined);
    assert.equal(task.option.DeliveryJobsAutoDeliveryPreferZipline.default_case, "No");
    for (const [
        index,
        zip,
    ] of [
        false,
        true,
    ].entries()) {
        const itemCase = task.option.DeliveryJobsAutoDeliveryPreferZipline.cases[index];
        assert.deepEqual(Object.keys(itemCase.pipeline_override), AUTO_DELIVERY_NAVIGATE_NODES);
        for (const node of AUTO_DELIVERY_NAVIGATE_NODES) {
            assert.deepEqual(itemCase.pipeline_override[node].attach, {
                zip,
            });
        }
    }
    for (const depot of deliveryJobDepots) {
        assert.equal(task.option[`DeliveryJobsPostAcceptAction${depot.Id}`], undefined);
        assert.equal(task.option[`DeliveryJobsAtLeastMinimumPostAcceptAction${depot.Id}`], undefined);
        assert.equal(task.option[`DeliveryJobsBelowMinimumPostAcceptAction${depot.Id}`], undefined);
    }
});

test("DeliveryJobs ongoing delivery fallback overrides the shared call node once", () => {
    const task = readGeneratedTask();
    const fallback = task.option.DeliveryJobsOngoingDeliveryFallback;
    assert.equal(fallback.type, "switch");
    assert.equal(fallback.default_case, "No");
    assert.equal(fallback.cases.length, 2);

    const noCase = fallback.cases.find((itemCase) => itemCase.name === "No");
    assert.equal(noCase.pipeline_override, undefined);

    const yesCase = fallback.cases.find((itemCase) => itemCase.name === "Yes");
    assert.deepEqual(Object.keys(yesCase.pipeline_override), ["DeliveryJobsDeliverByAutoDelivery"]);
    assert.deepEqual(yesCase.pipeline_override.DeliveryJobsDeliverByAutoDelivery.on_error, [
        "DeliveryJobsTransferOngoingJob",
    ]);

    // 不再为每个仓储节点重复覆盖 on_error
    for (const depot of deliveryJobDepots) {
        assert.equal(yesCase.pipeline_override[`DeliveryJobsAutoDelivery${depot.Id}`], undefined);
    }
});

test("DeliveryJobs quote mode registers threshold and branch action options", () => {
    const task = readGeneratedTask();
    for (const depot of deliveryJobDepots) {
        const {byName, deliveryNode, cargoNode, ongoingNode} = getDepotModeContext(task, depot);
        assert.deepEqual(byName.ByQuote.option, [
            `DeliveryJobsQuoteThreshold${depot.Id}`,
            `DeliveryJobsAtLeastMinimumQuoteAction${depot.Id}`,
            `DeliveryJobsBelowMinimumQuoteAction${depot.Id}`,
        ]);
        assert.equal(byName.ByQuote.pipeline_override[deliveryNode].enabled, false);
        assert.equal(byName.ByQuote.pipeline_override[cargoNode].enabled, true);
        assert.equal(
            byName.ByQuote.pipeline_override[cargoNode].anchor.DeliveryJobsRedistributionBidAction,
            `DeliveryJobsDecide${depot.Id}Quote`,
        );
        assert.deepEqual(byName.ByQuote.pipeline_override[ongoingNode].next, [
            "DeliveryJobsSkipOngoingDelivery",
        ]);
        assert.equal(byName.ByQuote.pipeline_override[cargoNode].anchor.DeliveryJobsGoToDepot, depot.DepotScene);
    }
});

test("DeliveryJobs quote threshold configures both comparison nodes", () => {
    const task = readGeneratedTask();
    for (const depot of deliveryJobDepots) {
        const thresholdOption = task.option[`DeliveryJobsQuoteThreshold${depot.Id}`];
        const thresholdInput = thresholdOption.inputs[0];
        assert.equal(thresholdOption.type, "input");
        assert.equal(thresholdInput.default, "119000");
        assert.equal(thresholdInput.pipeline_type, "string");
        assert.deepEqual(
            thresholdOption.pipeline_override[`DeliveryJobs${depot.Id}QuoteAtLeastMinimum`].custom_recognition_param,
            {
                expression: `{DeliveryJobsSelectedBidPrice}>={${thresholdInput.name}}`,
            },
        );
        assert.deepEqual(
            thresholdOption.pipeline_override[`DeliveryJobs${depot.Id}QuoteBelowMinimum`].custom_recognition_param,
            {
                expression: `{DeliveryJobsSelectedBidPrice}<{${thresholdInput.name}}`,
            },
        );
    }
});

test("DeliveryJobs quote branches share actions with branch-specific defaults", () => {
    const task = readGeneratedTask();
    for (const depot of deliveryJobDepots) {
        const quoteActionOptions = [
            {
                option: task.option[`DeliveryJobsAtLeastMinimumQuoteAction${depot.Id}`],
                comparison: "AtLeastMinimum",
                defaultCase: "Transfer",
            },
            {
                option: task.option[`DeliveryJobsBelowMinimumQuoteAction${depot.Id}`],
                comparison: "BelowMinimum",
                defaultCase: "AcceptJobOnly",
            },
        ];
        for (const {option: quoteAction, comparison, defaultCase} of quoteActionOptions) {
            assert.equal(quoteAction.type, "select");
            assert.equal(quoteAction.default_case, defaultCase);
            assert.deepEqual(
                quoteAction.cases.map((mode) => mode.name),
                [
                    "Transfer",
                    ...(depot.AutoDeliverySupported
                        ? [
                              "AutoDelivery",
                          ]
                        : []),
                    "AcceptJobOnly",
                    "DoNotAccept",
                ],
            );
            assert.equal(quoteAction.cases.find((mode) => mode.name === "AcceptJobOnly").option, undefined);
            const comparisonNode = `DeliveryJobs${depot.Id}Quote${comparison}`;
            const expectedAnchors = [
                {
                    DeliveryJobsQuoteAction: "DeliveryJobsQuoteTransferJob",
                    DeliveryJobsGoToDepot: `DeliveryJobsReturnAndTransfer${depot.Id}`,
                },
                ...(depot.AutoDeliverySupported
                    ? [
                          {
                              DeliveryJobsQuoteAction: "DeliveryJobsQuoteAcceptJobOnly",
                              DeliveryJobsGoToDepot: `DeliveryJobsAutoDelivery${depot.Id}`,
                          },
                      ]
                    : []),
                {
                    DeliveryJobsQuoteAction: "DeliveryJobsQuoteAcceptJobOnly",
                    DeliveryJobsGoToDepot: depot.DepotScene,
                },
                {
                    DeliveryJobsQuoteAction: "DeliveryJobsQuoteDoNotAccept",
                    DeliveryJobsGoToDepot: depot.DepotScene,
                },
            ];
            assert.deepEqual(
                quoteAction.cases.map((mode) => mode.pipeline_override[comparisonNode].anchor),
                expectedAnchors,
            );
        }
    }
});

test("DeliveryJobs shared bid page locates the selected quote", () => {
    const pipeline = readGeneratedPipeline("DeliveryJobs", "PackCargo.json");
    const adbPipeline = readAdbPipeline("DeliveryJobs", "PackCargo.json");
    assert.deepEqual(
        pipeline.DeliveryJobsSelectedBidLocationIcon.roi,
        [
            970,
            132,
            223,
            106,
        ],
    );
    assert.equal(pipeline.DeliveryJobsSelectedBidLocationIcon.template, "DeliveryJobs/LocationIcon.png");
    assert.ok(existsSync(new URL("../../../assets/resource/image/DeliveryJobs/LocationIcon.png", import.meta.url)));
    assert.ok(existsSync(new URL("../../../assets/resource_adb/image/DeliveryJobs/LocationIcon.png", import.meta.url)));
    assert.equal(pipeline.DeliveryJobsSelectedBidPriceOCR.roi, "DeliveryJobsSelectedBidLocationIcon");
    assert.deepEqual(
        pipeline.DeliveryJobsSelectedBidPriceOCR.roi_offset,
        [
            137,
            16,
            28,
            -2,
        ],
    );
    assert.deepEqual(
        adbPipeline.DeliveryJobsSelectedBidPriceOCR.roi_offset,
        [
            170,
            20,
            35,
            -3,
        ],
    );
    assert.equal(pipeline.DeliveryJobsSelectedBidPriceOCR.only_rec, true);
    assert.deepEqual(pipeline.DeliveryJobsSelectedBidPriceOCR.expected, ["\\d+(?:[.,]\\d+)?"]);
    assert.deepEqual(pipeline.DeliveryJobsSelectedBidPriceOCR.replace, [
        [
            "方",
            "万",
        ],
    ]);
});

test("DeliveryJobs generated packing priorities configure ordered IconRecognition entries", () => {
    const pipeline = readGeneratedPipeline("DeliveryJobs", "PriorityItems.json");
    const adbPipeline = readAdbPipeline("DeliveryJobs", "PriorityItems.json");
    for (const region of deliveryJobRegions) {
        const defaultItem = region.FillItems.find((item) => item.Id === region.DefaultFillItem);
        for (let priority = 1; priority <= DELIVERY_JOB_FILL_ITEM_PRIORITY_COUNT; priority += 1) {
            const startNode = pipeline[`DeliveryJobsStartFill${region.Id}Priority${priority}`];
            const selectNode = pipeline[`DeliveryJobsSelectItemToFill${region.Id}Priority${priority}`];
            const continueNode = pipeline[`DeliveryJobsContinueFill${region.Id}AfterPriority${priority}`];
            assert.equal(startNode.enabled, priority === 1);
            assert.equal(selectNode.enabled, priority === 1);
            assert.deepEqual(startNode.anchor, {
                DeliveryJobsCurrentPriorityItem: `DeliveryJobsSelectItemToFill${region.Id}Priority${priority}`,
                DeliveryJobsNextPriority: `DeliveryJobsContinueFill${region.Id}AfterPriority${priority}`,
            });
            assert.deepEqual(startNode.custom_action_param.patch, {
                DeliveryJobsItemListAtTop: {attach: {ready: false}},
                DeliveryJobsItemListAtBottom: {attach: {ready: false}},
            });
            assert.equal(selectNode.recognition, "Custom");
            assert.equal(selectNode.custom_recognition, "IconRecognition");
            assert.deepEqual(selectNode.custom_recognition_param, {
                grid_type: "shipment",
                item_ids: [
                    region.DefaultFillItem,
                ],
                item_recheck_filters: [
                    defaultItem.RecheckFilter,
                ],
                deduplicate: true,
            });
            assert.equal(selectNode.action, "Click");
            assert.deepEqual(
                adbPipeline[`DeliveryJobsSelectItemToFill${region.Id}Priority${priority}`].roi,
                [
                    43,
                    169,
                    480,
                    408,
                ],
            );
            assert.deepEqual(continueNode.next, [
                ...Array.from(
                    {length: DELIVERY_JOB_FILL_ITEM_PRIORITY_COUNT - priority},
                    (_, index) => `DeliveryJobsStartFill${region.Id}Priority${priority + index + 1}`,
                ),
                "DeliveryJobsConfiguredFillItemsInsufficient",
            ]);
        }
    }
});

test("DeliveryJobs packing flow resets, scans, and falls back between configured priorities", () => {
    const pipeline = readGeneratedPipeline("DeliveryJobs", "PackCargo.json");
    const adbPipeline = readAdbPipeline("DeliveryJobs", "PackCargo.json");
    assert.deepEqual(pipeline.DeliveryJobsResetItemListLoop.next, [
        "DeliveryJobsItemListAtTop",
        "[JumpBack]DeliveryJobsSelectItemScrollDown",
    ]);
    assert.deepEqual(pipeline.DeliveryJobsSelectPriorityItemLoop.next, [
        "[Anchor]DeliveryJobsCurrentPriorityItem",
        "DeliveryJobsItemListAtBottom",
        "[JumpBack]DeliveryJobsSelectItemScrollUp",
    ]);
    for (const boundary of [
        "Top",
        "Bottom",
    ]) {
        const nodeName = `DeliveryJobsItemListAt${boundary}`;
        assert.equal(pipeline[nodeName].custom_recognition, "ListCompleteRecognition");
        assert.deepEqual(pipeline[nodeName].attach, {ready: false});
        assert.deepEqual(
            adbPipeline[nodeName].roi,
            [
                43,
                169,
                480,
                408,
            ],
        );
    }
    assert.deepEqual(pipeline.DeliveryJobsItemListAtBottom.next, [
        "[Anchor]DeliveryJobsNextPriority",
    ]);
    assert.deepEqual(pipeline.DeliveryJobsSelectItemScrollUp.next, [
        "MouseMoveReset",
    ]);
    assert.equal(pipeline.DeliveryJobsSelectItemScrollUp.duration, 200);
    assert.equal(pipeline.DeliveryJobsSelectItemScrollUp.end_hold, 400);
    assert.equal(pipeline.DeliveryJobsSelectItemScrollUp.max_hit, undefined);
    assert.deepEqual(pipeline.DeliveryJobsSelectItemScrollDown.next, [
        "MouseMoveReset",
    ]);
    assert.equal(pipeline.DeliveryJobsSelectItemScrollDown.duration, 200);
    assert.equal(pipeline.DeliveryJobsSelectItemScrollDown.end_hold, 400);
    assert.deepEqual(pipeline.DeliveryJobsFillCorrespondingGoods.next, [
        "DeliveryJobsFillToMaxNextStep",
        "[Anchor]DeliveryJobsNextPriority",
    ]);
    assert.equal(pipeline.DeliveryJobsConfiguredFillItemsInsufficient.custom_action, "FalseAction");
    assert.equal(
        pipeline.DeliveryJobsConfiguredFillItemsInsufficient.focus["Node.Recognition.Succeeded"],
        "$task.DeliveryJobs.ConfiguredFillItemsInsufficient",
    );
});

test("DeliveryJobs shared bid page dispatches through common quote actions", () => {
    const pipeline = readGeneratedPipeline("DeliveryJobs", "PackCargo.json");
    assert.deepEqual(pipeline.DeliveryJobsInCargoRedistributionBid.next, [
        "DeliveryJobsOngoingDelivery",
        "[Anchor]DeliveryJobsRedistributionBidAction",
    ]);
    assert.deepEqual(pipeline.DeliveryJobsQuoteTransferJob.next, [
        "DeliveryJobsRedistributionBidNextStep",
    ]);
    assert.deepEqual(pipeline.DeliveryJobsQuoteAcceptJobOnly.next, [
        "DeliveryJobsRedistributionBidNextStep",
    ]);
    assert.deepEqual(pipeline.DeliveryJobsRedistributionBidNextStep.next, [
        "DeliveryJobsBackToDepot",
        "[Anchor]DeliveryJobsAfterAcceptJob",
    ]);
    assert.equal(pipeline.DeliveryJobsQuoteAcceptJobOnly.anchor, undefined);
    assert.deepEqual(pipeline.DeliveryJobsQuoteDoNotAccept.next, [
        "InLocalDepotNode",
    ]);
    assert.equal(pipeline.DeliveryJobsQuoteDoNotAcceptStopped, undefined);
    assert.deepEqual(pipeline.DeliveryJobsOngoingDelivery.next, [
        "DeliveryJobsEnsureOngoingDeliveryMission",
    ]);
    assert.equal(pipeline.DeliveryJobsOngoingDelivery.action, undefined);
    assert.equal(pipeline.DeliveryJobsOngoingDelivery.anchor, undefined);
    assert.deepEqual(pipeline.DeliveryJobsEnsureOngoingDeliveryMission.custom_action_param, {
        sub: [
            "AutoDeliveryEnsureDeliveryMissionSelected",
        ],
        continue: false,
        strict: true,
    });
    assert.deepEqual(pipeline.DeliveryJobsEnsureOngoingDeliveryMission.next, [
        "DeliveryJobsResolveOngoingDepot",
    ]);
    assert.deepEqual(pipeline.DeliveryJobsResolveOngoingDepot.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckAreaText",
    ]);
    assert.equal(pipeline.DeliveryJobsResolveOngoingDepot.box_index, 1);
    assert.equal(pipeline.DeliveryJobsResolveOngoingDepot.custom_action, "DeliveryJobsResolveOngoingDepotAction");
    assert.deepEqual(pipeline.DeliveryJobsResolveOngoingDepot.next, [
        "DeliveryJobsSkipOngoingDelivery",
    ]);
    assert.deepEqual(pipeline.DeliveryJobsSkipOngoingDelivery.next, [
        "[Anchor]DeliveryJobsReturnToDepotNode",
    ]);
});

test("DeliveryJobs and SeizeDeliveryJobs compose AutoDelivery through continuation anchors", () => {
    const shared = readGeneratedPipeline("DeliveryJobs", "AutoDelivery.json");
    assert.equal(shared.DeliveryJobsAutoDeliveryGuard, undefined);
    assert.equal(shared.DeliveryJobsDeliverByAutoDelivery.custom_action, "SubTask");
    assert.deepEqual(shared.DeliveryJobsDeliverByAutoDelivery.custom_action_param, {
        sub: [
            "AutoDelivery",
        ],
        continue: false,
        strict: true,
    });
    assert.deepEqual(shared.DeliveryJobsDeliverByAutoDelivery.next, [
        "[Anchor]DeliveryJobsAfterAutoDelivery",
    ]);
    for (const node of [
        "DeliveryJobsAutoDeliveryDone",
        "DeliveryJobsAutoDeliveryFailed",
        "DeliveryJobsWaitCurrentJobDetail",
        "__DeliveryJobsCurrentJobArea",
        "__DeliveryJobsCurrentJobActionButton",
        "__DeliveryJobsCurrentJobStartTrackingButton",
        "DeliveryJobsCancelCurrentJobTracking",
        "__DeliveryJobsRecoCancelCurrentJobTracking",
        "__DeliveryJobsCancelCurrentJobTracking",
        "__DeliveryJobsCurrentJobTrackingAlreadyOff",
        "__DeliveryJobsCurrentJobTrackingGone",
    ]) {
        assert.equal(shared[node], undefined);
    }

    for (const depot of deliveryJobDepots) {
        const pipeline = readGeneratedPipeline("DeliveryJobs", "Depot", depot.RegionId, `${depot.Id}.json`);
        assert.deepEqual(pipeline[`DeliveryJobsAutoDelivery${depot.Id}`].anchor, {
            DeliveryJobsAfterAutoDelivery: `DeliveryJobs${depot.RegionId}Loop`,
            DeliveryJobsReturnToDepotNode: depot.DepotScene,
        });
        assert.deepEqual(pipeline[`DeliveryJobsAutoDelivery${depot.Id}`].next, [
            "DeliveryJobsDeliverByAutoDelivery",
        ]);
        assert.equal(pipeline[`DeliveryJobsAutoDelivery${depot.Id}`].focus, undefined);
        for (const node of [
            `DeliveryJobsPrepareAutoDelivery${depot.Id}`,
            `DeliveryJobsResumeAutoDelivery${depot.Id}`,
            `DeliveryJobsPickupAndDeliver${depot.Id}`,
            `DeliveryJobsOpenCurrentJobAfterPickup${depot.Id}`,
            `DeliveryJobsOpenCurrentJobForDestination${depot.Id}`,
            `DeliveryJobsTeleportToDestination${depot.Id}`,
            `DeliveryJobsPrepareDepotNavigation${depot.Id}`,
            `DeliveryJobsCancelTrackingForDepot${depot.Id}`,
            `DeliveryJobsReturnWorldAndNavigateDepot${depot.Id}`,
            `DeliveryJobsPrepareDestinationNavigation${depot.Id}`,
            `DeliveryJobsPrepareDestinationAfterTeleport${depot.Id}`,
            `DeliveryJobsTeleportToDepot${depot.Id}`,
            `DeliveryJobsReturnWorldAndNavigateDestination${depot.Id}`,
        ]) {
            assert.equal(pipeline[node], undefined);
        }
        assert.equal(
            Object.values(pipeline).some((node) => node.template === "AutoDelivery/CarryingGoods.png"),
            false,
        );
    }

    const seize = readGeneratedPipeline("SeizeDeliveryJobs", "AutoDeliveryAdapter.json");
    assert.equal(seize.SeizeDeliveryJobsPostProcessingEntry.anchor, undefined);
    assert.deepEqual(seize.SeizeDeliveryJobsTeleport.anchor, {
        AutoDeliveryAfterRecognizeDestination: "SeizeDeliveryJobsDeliveryCannotTeleport",
        AutoDeliveryAfterQuickTeleport: "SeizeDeliveryJobsSuccessTeleportDone",
    });
    assert.deepEqual(seize.SeizeDeliveryJobsTeleport.next, [
        "AutoDelivery",
    ]);
    assert.deepEqual(seize.SeizeDeliveryJobsTeleportAndWalk.anchor, {
        AutoDeliveryAfterRecognizeDestination: "SeizeDeliveryJobsDeliveryCannotTeleport",
        AutoDeliveryAfterNavigateDepot: "SeizeDeliveryJobsRestoreTrackingAfterWalk",
    });
    assert.deepEqual(seize.SeizeDeliveryJobsTeleportAndWalk.next, [
        "AutoDelivery",
    ]);
    assert.equal(seize.SeizeDeliveryJobsRestoreTrackingAfterWalk.custom_action, "SubTask");
    assert.deepEqual(seize.SeizeDeliveryJobsRestoreTrackingAfterWalk.custom_action_param, {
        sub: [
            "AutoDeliveryEnsureDeliveryMissionSelected",
        ],
        continue: false,
        strict: true,
    });
    assert.deepEqual(seize.SeizeDeliveryJobsRestoreTrackingAfterWalk.next, [
        "SeizeDeliveryJobsCheckDeliveryMissionTrackedAfterWalk",
        "SeizeDeliveryJobsStartTrackingAfterWalk",
    ]);
    assert.deepEqual(seize.SeizeDeliveryJobsCheckDeliveryMissionTrackedAfterWalk.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckCancelCurrentJobTrackingButton",
    ]);
    assert.deepEqual(seize.SeizeDeliveryJobsCheckDeliveryMissionTrackedAfterWalk.next, [
        "SeizeDeliveryJobsReturnWorldAfterTracking",
    ]);
    assert.deepEqual(seize.SeizeDeliveryJobsStartTrackingAfterWalk.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckStartTrackingButton",
    ]);
    assert.equal(seize.SeizeDeliveryJobsStartTrackingAfterWalk.action, "Click");
    assert.deepEqual(seize.SeizeDeliveryJobsStartTrackingAfterWalk.next, [
        "SeizeDeliveryJobsInDestinationMapAfterTracking",
    ]);
    assert.deepEqual(seize.SeizeDeliveryJobsInDestinationMapAfterTracking.all_of, [
        "AutoDeliveryInTaskDestinationMap",
    ]);
    assert.deepEqual(seize.SeizeDeliveryJobsInDestinationMapAfterTracking.next, [
        "SeizeDeliveryJobsReturnWorldAfterTracking",
    ]);
    assert.deepEqual(seize.SeizeDeliveryJobsReturnWorldAfterTracking.custom_action_param, {
        sub: [
            "SceneAnyEnterWorld",
        ],
        continue: false,
        strict: true,
    });
    assert.deepEqual(seize.SeizeDeliveryJobsReturnWorldAfterTracking.next, [
        "SeizeDeliveryJobsSuccessWalkDone",
    ]);
    assert.deepEqual(seize.SeizeDeliveryJobsFullDelivery.anchor, {
        AutoDeliveryAfterSubmitGoods: "SeizeDeliveryJobsMain",
    });
    assert.deepEqual(seize.SeizeDeliveryJobsFullDelivery.next, [
        "AutoDelivery",
    ]);
    const seizeCommon = readGeneratedPipeline("SeizeDeliveryJobs", "SeizeDeliveryJobsCommon.json");
    assert.notEqual(seizeCommon.__SeizeDeliveryJobsRecoViewCurrentJob, undefined);
    for (const node of [
        "SeizeDeliveryJobsEnterCurrentJobDetail",
        "__SeizeDeliveryJobsReadyToViewCurrentJob",
        "__SeizeDeliveryJobsViewCurrentJob",
    ]) {
        assert.equal(seizeCommon[node], undefined);
    }
    assert.equal(seize.SeizeDeliveryJobsOpenCurrentJobForDestination, undefined);
    assert.equal(
        seize.SeizeDeliveryJobsDeliveryCannotTeleport.focus["Node.Recognition.Succeeded"],
        "$task.SeizeDeliveryJobs.focus.deliveryCannotTeleport",
    );
    for (const node of [
        "SeizeDeliveryJobsResumeDelivery",
        "SeizeDeliveryJobsPickupAndDeliver",
        "SeizeDeliveryJobsReturnWorldAndNavigateDestination",
        "SeizeDeliveryJobsPrepareDepotNavigation",
        "SeizeDeliveryJobsCancelTrackingForDepot",
        "SeizeDeliveryJobsReturnWorldAndNavigateDepot",
        "SeizeDeliveryJobsPrepareDestinationNavigation",
        "SeizeDeliveryJobsPrepareDestinationAfterTeleport",
        "SeizeDeliveryJobsCancelCurrentJobTracking",
        "__SeizeDeliveryJobsRecoCancelCurrentJobTracking",
        "__SeizeDeliveryJobsCancelCurrentJobTracking",
        "__SeizeDeliveryJobsCurrentJobTrackingAlreadyOff",
        "__SeizeDeliveryJobsCurrentJobTrackingGone",
    ]) {
        assert.equal(seize[node], undefined);
    }
    assert.equal(JSON.stringify(seize).includes("AutoDelivery/CarryingGoods.png"), false);
});

test("AutoDelivery ensures the delivery mission detail before branching", () => {
    const common = readGeneratedPipeline("AutoDelivery", "Common.json");
    const commonAdb = readAdbPipeline("AutoDelivery", "Common.json");
    const pickup = readGeneratedPipeline("AutoDelivery", "Pickup.json");
    const delivery = readGeneratedPipeline("AutoDelivery", "Delivery.json");
    const sceneMenu = readGeneratedPipeline("SceneManager", "SceneMenu.json");
    const missionScene = readGeneratedPipeline("Interface", "InScene", "Mission.json");

    const pipeline = {
        ...common,
        ...pickup,
        ...delivery,
    };
    assert.ok(pipeline.AutoDelivery);
    assert.equal(Object.keys(common)[0], "AutoDelivery");
    assert.equal(Object.keys(pickup)[0], "AutoDeliveryRecognizeDepot");
    assert.equal(Object.keys(delivery)[0], "AutoDeliveryRecognizeDestination");
    assert.equal(common.AutoDeliveryRecognizeDepot, undefined);
    assert.equal(common.AutoDeliveryRecognizeDestination, undefined);
    assert.equal(
        Object.keys(pipeline).some((node) => node.startsWith("__")),
        false,
    );
    assert.equal(common.AutoDelivery.anchor, undefined);
    assert.deepEqual(common.AutoDelivery.focus, {
        "Node.Recognition.Succeeded": "$task.AutoDelivery.focus.start",
    });
    assert.equal(common.AutoDelivery.recognition, undefined);
    assert.equal(common.AutoDelivery.action, "Custom");
    assert.equal(common.AutoDelivery.custom_action, "SubTask");
    assert.deepEqual(common.AutoDelivery.custom_action_param, {
        sub: [
            "AutoDeliveryEnsureDeliveryMissionSelected",
        ],
        continue: false,
        strict: true,
    });
    assert.equal(common.AutoDeliveryCheckCurrentJobActionButton, undefined);
    assert.deepEqual(common.AutoDeliveryCheckStartTrackingButton.template, [
        "Common/Button/WhiteConfirmButtonType1.png",
        "Common/Button/WhiteConfirmButtonType1Hover.png",
    ]);
    assert.deepEqual(common.AutoDelivery.next, [
        "AutoDeliveryRecognizeDestination",
        "AutoDeliveryRecognizeDepot",
    ]);
    assert.deepEqual(pickup.AutoDeliveryRecognizeDepot.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckAreaText",
    ]);
    assert.equal(pickup.AutoDeliveryRecognizeDepot.custom_action, "AutoDeliveryResolveDepotAction");
    assert.equal(pickup.AutoDeliveryRecognizeDepot.custom_action_param, undefined);
    assert.deepEqual(pickup.AutoDeliveryRecognizeDepot.next, [
        "AutoDeliveryQuickTeleport",
    ]);
    assert.deepEqual(delivery.AutoDeliveryRecognizeDestination.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckAreaText",
        "AutoDeliveryCheckDestinationField",
    ]);
    assert.equal(delivery.AutoDeliveryRecognizeDestination.custom_action, "AutoDeliveryResolveDestinationAction");
    assert.equal(delivery.AutoDeliveryRecognizeDestination.custom_action_param, undefined);
    assert.deepEqual(delivery.AutoDeliveryRecognizeDestination.next, [
        "[Anchor]AutoDeliveryAfterRecognizeDestination",
        "AutoDeliveryAfterResolveDestination",
    ]);
    assert.deepEqual(delivery.AutoDeliveryAfterResolveDestination.next, [
        "AutoDeliveryCancelCurrentJobTracking",
        "AutoDeliveryCheckCurrentJobTrackingAlreadyOff",
    ]);
    assert.deepEqual(delivery.AutoDeliveryPrepareNavigateDestination.custom_action_param, {
        sub: [
            "AutoDeliveryEnsureDeliveryMissionSelected",
        ],
        continue: false,
        strict: true,
    });
    assert.deepEqual(delivery.AutoDeliveryPrepareNavigateDestination.next, [
        "AutoDeliveryCancelCurrentJobTracking",
        "AutoDeliveryCheckCurrentJobTrackingAlreadyOff",
    ]);
    assert.deepEqual(pickup.AutoDeliveryNavigateDepot.attach, {
        zip: false,
    });
    assert.deepEqual(delivery.AutoDeliveryNavigateDestination.attach, {
        zip: false,
    });
    assert.deepEqual(pickup.AutoDeliveryInWorldAfterQuickTeleport.next, [
        "[Anchor]AutoDeliveryAfterQuickTeleport",
        "AutoDeliveryPrepareNavigateDepot",
    ]);
    assert.equal(pickup.AutoDeliveryPrepareNavigateDepot.custom_action, "SubTask");
    assert.deepEqual(pickup.AutoDeliveryPrepareNavigateDepot.custom_action_param, {
        sub: [
            "AutoDeliveryEnsureDeliveryMissionSelected",
        ],
        continue: false,
        strict: true,
    });
    assert.deepEqual(pickup.AutoDeliveryPrepareNavigateDepot.next, [
        "AutoDeliveryCancelTrackingBeforeNavigateDepot",
        "AutoDeliveryCheckTrackingAlreadyOffBeforeNavigateDepot",
    ]);
    assert.deepEqual(pickup.AutoDeliveryCancelTrackingBeforeNavigateDepot.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckCancelCurrentJobTrackingButton",
    ]);
    assert.equal(pickup.AutoDeliveryCancelTrackingBeforeNavigateDepot.action, "Click");
    assert.deepEqual(pickup.AutoDeliveryCancelTrackingBeforeNavigateDepot.next, [
        "AutoDeliveryCheckTrackingGoneBeforeNavigateDepot",
    ]);
    assert.deepEqual(pickup.AutoDeliveryCheckTrackingAlreadyOffBeforeNavigateDepot.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckStartTrackingButton",
    ]);
    assert.deepEqual(pickup.AutoDeliveryCheckTrackingAlreadyOffBeforeNavigateDepot.next, [
        "AutoDeliveryReturnWorldAndNavigateDepot",
    ]);
    assert.deepEqual(pickup.AutoDeliveryCheckTrackingGoneBeforeNavigateDepot.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckStartTrackingButton",
    ]);
    assert.deepEqual(pickup.AutoDeliveryCheckTrackingGoneBeforeNavigateDepot.next, [
        "AutoDeliveryReturnWorldAndNavigateDepot",
    ]);
    assert.deepEqual(pickup.AutoDeliveryReturnWorldAndNavigateDepot.custom_action_param.sub, [
        "SceneAnyEnterWorld",
    ]);
    assert.deepEqual(pickup.AutoDeliveryReturnWorldAndNavigateDepot.next, [
        "AutoDeliveryNavigateDepot",
    ]);
    assert.deepEqual(pickup.AutoDeliveryStartTrackingTask.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckStartTrackingButton",
    ]);
    assert.deepEqual(pickup.AutoDeliveryViewDestinationMap.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "TrackedMissionMapButton",
    ]);
    assert.equal(pickup.AutoDeliveryNavigateDepot.custom_action, "FalseAction");
    assert.deepEqual(pickup.AutoDeliveryNavigateDepot.next, [
        "[Anchor]AutoDeliveryAfterNavigateDepot",
        "AutoDeliveryFetchGoods",
    ]);
    assert.deepEqual(pickup.AutoDeliveryFetchGoods.next, [
        "AutoDeliveryCheckFetchGoodsButton",
        "AutoDeliverySearchFetchGoodsButton",
    ]);
    assert.equal(pickup.AutoDeliverySearchFetchGoodsButton.custom_action, "CharacterSearchAction");
    assert.deepEqual(pickup.AutoDeliverySearchFetchGoodsButton.custom_action_param.wait_nodes, [
        "AutoDeliveryCheckFetchGoodsButton",
    ]);
    assert.deepEqual(pickup.AutoDeliverySearchFetchGoodsButton.next, [
        "AutoDeliveryCheckFetchGoodsButton",
    ]);
    assert.deepEqual(pickup.AutoDeliverySearchFetchGoodsButton.on_error, [
        "AutoDeliveryRetryNavigateDepot",
    ]);
    assert.equal(pickup.AutoDeliveryRetryNavigateDepot.enabled, false);
    assert.equal(pickup.AutoDeliveryRetryNavigateDepot.custom_action, "FalseAction");
    assert.deepEqual(pickup.AutoDeliveryRetryNavigateDepot.next, [
        "AutoDeliveryCheckFetchGoodsButton",
    ]);
    assert.equal(pickup.AutoDeliveryCheckFetchGoodsButton.recognition, "TemplateMatch");
    assert.deepEqual(
        pickup.AutoDeliveryCheckFetchGoodsButton.roi,
        [
            763,
            349,
            195,
            270,
        ],
    );
    assert.equal(pickup.AutoDeliveryCheckFetchGoodsButton.template, "AutoDelivery/FetchGoods.png");
    assert.equal(pickup.AutoDeliveryCheckFetchGoodsButton.order_by, "Score");
    assert.equal(pickup.AutoDeliveryCheckFetchGoodsButton.expected, undefined);
    assert.deepEqual(
        commonAdb.AutoDeliveryCheckFetchGoodsButton.roi,
        [
            720,
            349,
            240,
            270,
        ],
    );
    for (const resource of [
        "resource",
        "resource_adb",
    ]) {
        assert.ok(
            existsSync(new URL(`../../../assets/${resource}/image/AutoDelivery/FetchGoods.png`, import.meta.url)),
        );
    }
    assert.deepEqual(pickup.AutoDeliveryCheckFetchGoodsButton.pre_wait_freezes, {
        time: 300,
        target: [
            763,
            349,
            195,
            270,
        ],
    });
    assert.deepEqual(pickup.AutoDeliveryFetchGoodsButton.all_of, [
        "AutoDeliveryCheckFetchGoodsButton",
    ]);
    assert.deepEqual(pickup.AutoDeliveryFetchGoodsButton.next, [
        "AutoDeliveryOpenMissionAfterFetchGoods",
    ]);
    assert.equal(pickup.AutoDeliveryCheckCarryingGoods, undefined);
    assert.deepEqual(pickup.AutoDeliveryOpenMissionAfterFetchGoods.next, [
        "AutoDeliveryRecognizeDestination",
    ]);
    assert.equal(pickup.AutoDeliveryOpenMissionAfterFetchGoods.custom_action, "SubTask");
    assert.deepEqual(pickup.AutoDeliveryOpenMissionAfterFetchGoods.custom_action_param, {
        sub: [
            "AutoDeliveryEnsureDeliveryMissionSelected",
        ],
        continue: false,
        strict: true,
    });
    assert.deepEqual(common.AutoDeliveryEnsureDeliveryMissionSelected.next, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryOpenDeliveryMission",
    ]);
    assert.equal(common.AutoDeliveryEnsureDeliveryMissionSelected.action, undefined);
    assert.equal(common.AutoDeliveryOpenDeliveryMission.custom_action, "SubTask");
    assert.deepEqual(common.AutoDeliveryOpenDeliveryMission.custom_action_param, {
        sub: [
            "SceneEnterMenuMission",
            "AutoDeliverySelectDeliveryMissionFromList",
        ],
        continue: false,
        strict: true,
    });
    assert.deepEqual(common.AutoDeliverySelectDeliveryMissionFromList.next, [
        "AutoDeliveryCheckDeliveryMissionSelected",
        "AutoDeliverySelectDeliveryMission",
        "AutoDeliveryCheckDeliveryMissionListComplete",
        "[JumpBack]AutoDeliveryScrollMissionList",
    ]);
    assert.equal(common.AutoDeliverySelectDeliveryMissionFromList.custom_action, "PipelineOverrideAction");
    assert.deepEqual(common.AutoDeliverySelectDeliveryMissionFromList.custom_action_param, {
        patch: {
            AutoDeliveryCheckDeliveryMissionListComplete: {
                attach: {
                    ready: false,
                },
            },
        },
    });
    assert.equal(common.AutoDeliveryCheckDeliveryMissionListComplete.custom_recognition, "ListCompleteRecognition");
    assert.deepEqual(common.AutoDeliveryCheckDeliveryMissionListComplete.custom_recognition_param, {
        threshold: 0.98,
    });
    assert.deepEqual(
        common.AutoDeliveryCheckDeliveryMissionListComplete.roi,
        [
            42,
            70,
            360,
            590,
        ],
    );
    assert.deepEqual(common.AutoDeliveryCheckDeliveryMissionListComplete.attach, {
        ready: false,
    });
    assert.deepEqual(common.AutoDeliveryCheckDeliveryMissionListComplete.next, [
        "AutoDeliveryDeliveryMissionNotFound",
    ]);
    assert.deepEqual(
        common.AutoDeliveryCheckDeliveryMissionListItem.roi,
        [
            42,
            70,
            360,
            590,
        ],
    );
    assert.deepEqual(common.AutoDeliveryCheckDeliveryMissionListItem.expected, [
        "送货任务",
        "送貨任務",
        "(?i)Delivery\\s*Job",
        "配達任務",
        "배송 임무",
    ]);
    assert.deepEqual(common.AutoDeliverySelectDeliveryMission.all_of, [
        "InMenuMission",
        "AutoDeliveryCheckDeliveryMissionListItem",
    ]);
    assert.equal(common.AutoDeliverySelectDeliveryMission.action, "Click");
    assert.deepEqual(common.AutoDeliverySelectDeliveryMission.next, [
        "AutoDeliveryCheckDeliveryMissionSelected",
    ]);
    assert.equal(common.AutoDeliveryScrollMissionList.max_hit, undefined);
    assert.deepEqual(common.AutoDeliveryScrollMissionList.all_of, [
        "InMenuMission",
    ]);
    assert.equal(common.AutoDeliveryScrollMissionList.action, "Swipe");
    assert.deepEqual(
        common.AutoDeliveryScrollMissionList.begin,
        [
            220,
            580,
        ],
    );
    assert.deepEqual(
        common.AutoDeliveryScrollMissionList.end,
        [
            220,
            250,
        ],
    );
    assert.deepEqual(common.AutoDeliveryDeliveryMissionNotFound.all_of, [
        "InMenuMission",
    ]);
    assert.equal(common.AutoDeliveryDeliveryMissionNotFound.custom_action, "FalseAction");
    assert.equal(common.AutoDeliveryCheckDeliveryMissionSelected.next, undefined);
    assert.deepEqual(common.AutoDeliveryInDeliveryMissionDetail.all_of, [
        "InMenuMission",
        "AutoDeliveryCheckDeliveryMissionSelected",
    ]);
    assert.deepEqual(
        commonAdb.AutoDeliveryCheckDeliveryMissionListComplete.roi,
        [
            105,
            85,
            450,
            590,
        ],
    );
    assert.deepEqual(
        commonAdb.AutoDeliveryCheckDeliveryMissionListItem.roi,
        [
            105,
            85,
            450,
            590,
        ],
    );
    assert.deepEqual(
        commonAdb.AutoDeliveryCheckDeliveryMissionSelected.roi,
        [
            570,
            70,
            260,
            60,
        ],
    );
    assert.deepEqual(commonAdb.AutoDeliveryScrollMissionList.post_wait_freezes, {
        time: 300,
        target: [
            105,
            85,
            450,
            590,
        ],
    });
    for (const node of [
        "AutoDeliveryCheckDeliveryMissionListComplete",
        "AutoDeliveryCheckDeliveryMissionListItem",
        "AutoDeliveryCheckDeliveryMissionSelected",
        "AutoDeliveryDeliveryMissionNotFound",
        "AutoDeliveryEnsureDeliveryMissionSelected",
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryOpenDeliveryMission",
        "AutoDeliveryScrollMissionList",
        "AutoDeliverySelectDeliveryMission",
        "AutoDeliverySelectDeliveryMissionFromList",
    ]) {
        assert.ok(common[node], `${node} should be defined in Common.json`);
        assert.equal(pickup[node], undefined, `${node} should not be defined in Pickup.json`);
    }
    assert.equal(common.AutoDeliveryInMissionMenu, undefined);
    assert.deepEqual(
        missionScene.InMenuMission.recognition.param.roi,
        [
            0,
            0,
            150,
            70,
        ],
    );
    assert.deepEqual(missionScene.InMenuMission.recognition.param.expected, [
        "任务",
        "任務",
        "(?i)Missions",
        "任務",
        "임무",
    ]);
    assert.deepEqual(sceneMenu.__ScenePrivateAnyEnterMenuMissionSuccess.all_of, [
        "InMenuMission",
    ]);
    assert.equal(sceneMenu.__ScenePrivateMenuListScrollToMission.max_hit, 3);
    assert.equal(sceneMenu.__ScenePrivateWorldEnterMenuMission.action.param.custom_action, "ClearHitCount");
    assert.deepEqual(sceneMenu.__ScenePrivateWorldEnterMenuMission.action.param.custom_action_param, {
        nodes: [
            "__ScenePrivateMenuListScrollToMission",
        ],
        strict: true,
    });
    assert.deepEqual(delivery.AutoDeliveryCancelCurrentJobTracking.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckCancelCurrentJobTrackingButton",
    ]);
    assert.equal(delivery.AutoDeliveryCancelCurrentJobTracking.action, "Click");
    assert.deepEqual(delivery.AutoDeliveryCancelCurrentJobTracking.next, [
        "AutoDeliveryCheckCurrentJobTrackingGone",
    ]);
    assert.deepEqual(delivery.AutoDeliveryCheckCurrentJobTrackingAlreadyOff.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckStartTrackingButton",
    ]);
    assert.deepEqual(delivery.AutoDeliveryCheckCurrentJobTrackingAlreadyOff.next, [
        "AutoDeliveryReturnWorldAndNavigateDestination",
    ]);
    assert.deepEqual(delivery.AutoDeliveryCheckCurrentJobTrackingGone.all_of, [
        "AutoDeliveryInDeliveryMissionDetail",
        "AutoDeliveryCheckStartTrackingButton",
    ]);
    assert.deepEqual(delivery.AutoDeliveryCheckCurrentJobTrackingGone.next, [
        "AutoDeliveryReturnWorldAndNavigateDestination",
    ]);
    assert.deepEqual(delivery.AutoDeliveryReturnWorldAndNavigateDestination.custom_action_param.sub, [
        "SceneAnyEnterWorld",
    ]);
    assert.deepEqual(delivery.AutoDeliveryReturnWorldAndNavigateDestination.next, [
        "AutoDeliveryNavigateDestination",
    ]);
    assert.equal(delivery.AutoDeliveryNavigateDestination.custom_action, "FalseAction");
    assert.equal(delivery.AutoDeliveryNavigateDestination.custom_action_param, undefined);
    assert.deepEqual(delivery.AutoDeliveryNavigateDestination.next, [
        "AutoDeliveryCheckSubmitGoodsButton",
        "AutoDeliverySearchSubmitGoodsButton",
    ]);
    assert.equal(delivery.AutoDeliverySearchSubmitGoodsButton.custom_action, "CharacterSearchAction");
    assert.deepEqual(delivery.AutoDeliverySearchSubmitGoodsButton.custom_action_param.wait_nodes, [
        "AutoDeliveryCheckSubmitGoodsButton",
    ]);
    assert.deepEqual(delivery.AutoDeliverySearchSubmitGoodsButton.next, [
        "AutoDeliveryCheckSubmitGoodsButton",
    ]);
    assert.deepEqual(delivery.AutoDeliverySearchSubmitGoodsButton.on_error, [
        "AutoDeliveryRetryNavigateDestination",
    ]);
    assert.equal(delivery.AutoDeliveryRetryNavigateDestination.enabled, false);
    assert.equal(delivery.AutoDeliveryRetryNavigateDestination.custom_action, "FalseAction");
    assert.deepEqual(delivery.AutoDeliveryRetryNavigateDestination.next, [
        "AutoDeliveryCheckSubmitGoodsButton",
    ]);
    assert.equal(delivery.AutoDeliveryCheckSubmitGoodsButton.recognition, "TemplateMatch");
    assert.deepEqual(
        delivery.AutoDeliveryCheckSubmitGoodsButton.roi,
        [
            760,
            350,
            200,
            270,
        ],
    );
    assert.deepEqual(delivery.AutoDeliveryCheckSubmitGoodsButton.template, [
        "AutoDelivery/SubmitGoods.png",
        "AutoDelivery/SubmitGoods2.png",
    ]);
    assert.equal(delivery.AutoDeliveryCheckSubmitGoodsButton.threshold, 0.8);
    assert.equal(delivery.AutoDeliveryCheckSubmitGoodsButton.order_by, "Score");
    assert.equal(delivery.AutoDeliveryCheckSubmitGoodsButton.expected, undefined);
    assert.deepEqual(
        commonAdb.AutoDeliveryCheckSubmitGoodsButton.roi,
        [
            720,
            349,
            240,
            270,
        ],
    );
    for (const resource of [
        "resource",
        "resource_adb",
    ]) {
        for (const template of [
            "SubmitGoods.png",
            "SubmitGoods2.png",
        ]) {
            assert.ok(
                existsSync(new URL(`../../../assets/${resource}/image/AutoDelivery/${template}`, import.meta.url)),
            );
        }
    }
    assert.deepEqual(delivery.AutoDeliveryCheckSubmitGoodsButton.pre_wait_freezes, {
        time: 300,
        target: [
            763,
            349,
            195,
            270,
        ],
    });
    assert.deepEqual(delivery.AutoDeliverySubmitGoods.all_of, [
        "AutoDeliveryCheckSubmitGoodsButton",
    ]);
    assert.deepEqual(delivery.AutoDeliverySubmitGoods.next, [
        "AutoDeliveryCheckSkipChatReady",
        "AutoDeliveryCloseRewardDialog",
    ]);
    assert.deepEqual(delivery.AutoDeliveryCheckSkipChatReady.next, [
        "AutoDeliverySkipChat",
    ]);
    assert.equal(delivery.AutoDeliverySkipChat.action, "TouchMove");
    assert.deepEqual(
        delivery.AutoDeliverySkipChat.target,
        [
            0,
            0,
            1,
            1,
        ],
    );
    assert.deepEqual(delivery.AutoDeliverySkipChat.next, [
        "AutoDeliveryCheckSkipChatAfterMoveAway",
    ]);
    assert.deepEqual(delivery.AutoDeliveryCheckSkipChatAfterMoveAway.all_of, [
        "AutoDeliveryInChatDialog",
        "AutoDeliveryCheckSkipChatButton",
    ]);
    assert.deepEqual(delivery.AutoDeliveryCheckSkipChatAfterMoveAway.next, [
        "AutoDeliverySkipChatMoveToButton",
    ]);
    assert.equal(delivery.AutoDeliverySkipChatMoveToButton.action, "TouchMove");
    assert.equal(delivery.AutoDeliverySkipChatMoveToButton.target, "AutoDeliveryCheckSkipChatAfterMoveAway");
    assert.deepEqual(delivery.AutoDeliverySkipChatMoveToButton.next, [
        "AutoDeliverySkipChatClick",
    ]);
    assert.equal(delivery.AutoDeliverySkipChatClick.action, "Click");
    assert.deepEqual(delivery.AutoDeliverySkipChatClick.next, [
        "AutoDeliverySkipChatConfirm",
        "AutoDeliveryCloseRewardDialog",
    ]);
    assert.deepEqual(delivery.AutoDeliverySkipChatConfirm.next, [
        "AutoDeliveryCloseRewardDialog",
    ]);
    assert.deepEqual(delivery.AutoDeliveryCloseRewardDialogClick.next, [
        "[Anchor]AutoDeliveryAfterSubmitGoods",
        "AutoDeliveryEnd",
    ]);
    assert.equal(JSON.stringify(common).includes('"anchor"'), false);
    assert.equal(JSON.stringify(pickup).includes('"anchor"'), false);
    assert.equal(JSON.stringify(delivery).includes('"anchor"'), false);
    assert.equal(JSON.stringify(common).includes('"on_error"'), false);
    assert.deepEqual(
        Object.entries(pickup)
            .filter(
                ([
                    ,
                    node,
                ]) => node.on_error !== undefined,
            )
            .map(([nodeName]) => nodeName),
        ["AutoDeliverySearchFetchGoodsButton"],
    );
    assert.deepEqual(
        Object.entries(delivery)
            .filter(
                ([
                    ,
                    node,
                ]) => node.on_error !== undefined,
            )
            .map(([nodeName]) => nodeName),
        ["AutoDeliverySearchSubmitGoodsButton"],
    );
    assert.equal(JSON.stringify(pickup).includes("MapLocateAssertLocation"), false);

    assert.equal(JSON.stringify(common).includes("SeizeDeliveryJobs"), false);
    assert.equal(JSON.stringify(pickup).includes("SeizeDeliveryJobs"), false);
    assert.equal(JSON.stringify(delivery).includes("SeizeDeliveryJobs"), false);
});

test("DeliveryJobs stops only at explicit safety boundaries", () => {
    const pipelineRoot = new URL("../../../assets/resource/pipeline/DeliveryJobs/", import.meta.url);
    const stopNodes = readdirSync(pipelineRoot, {recursive: true, withFileTypes: true})
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .flatMap((entry) => {
            const pipeline = readJsonc(join(entry.parentPath, entry.name));
            return Object.entries(pipeline)
                .filter(
                    ([
                        ,
                        node,
                    ]) => {
                        const action = typeof node.action === "string" ? node.action : node.action?.type;
                        return action === "StopTask";
                    },
                )
                .map(([nodeName]) => nodeName);
        })
        .sort();
    assert.deepEqual(stopNodes, [
        "DeliveryJobsBidPriceRecognitionFailed",
    ]);
});

test("DeliveryJobs no longer keeps stale handwritten region pipelines", () => {
    for (const region of deliveryJobRegions) {
        assert.equal(
            existsSync(new URL(`../../../assets/resource/pipeline/DeliveryJobs/${region.Id}.json`, import.meta.url)),
            false,
        );
    }
});

test("DeliveryJobs generated directories exactly match the current model", () => {
    const pipelineRoot = new URL("../../../assets/resource/pipeline/DeliveryJobs/", import.meta.url);
    const actualRegionFiles = readdirSync(new URL("Region/", pipelineRoot))
        .filter((name) => name.endsWith(".json"))
        .sort();
    assert.deepEqual(actualRegionFiles, deliveryJobRegions.map((region) => `${region.Id}.json`).sort());

    const depotRoot = new URL("Depot/", pipelineRoot);
    const depotRootPath = fileURLToPath(depotRoot);
    const actualDepotFiles = readdirSync(depotRoot, {recursive: true, withFileTypes: true})
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => relative(depotRootPath, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
        .sort();
    assert.deepEqual(actualDepotFiles, deliveryJobDepots.map((depot) => `${depot.RegionId}/${depot.Id}.json`).sort());
});
