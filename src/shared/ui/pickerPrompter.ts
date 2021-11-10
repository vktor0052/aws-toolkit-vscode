/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'

import { StepEstimator, WIZARD_BACK, WIZARD_EXIT } from '../wizards/wizard'
import { createRefreshButton, PrompterButtons } from './buttons'
import { PrompterConfiguration, PromptResult, Transform } from './prompter'
import { applyPrimitives, PartialCachedFunction } from '../utilities/collectionUtils'
import { recentlyUsed } from '../localizedText'
import { getLogger } from '../logger/logger'
import { RequireKey, UnionPromise } from '../utilities/tsUtils'
import { QuickInputPrompter } from './quickInput'

const localize = nls.loadMessageBundle()

/** Settings applied when using a QuickPickPrompter in 'filter-box input' mode. */
interface FilterBoxInput<T> {
    /** The label of the new QuickPickItem generated by the user's input. */
    label: string
    /** Parses the user's input into a the desired type. */
    transform: (v: string) => PromptResult<T>
    /** The inverse must be provided if using implicit state. */
    inverse?: (output: PromptResult<T>) => string
    /**
     * Checks for any errors in the input.
     * Returned strings are shown in the 'detail' part of the user-input QuickPickItem.
     */
    validator?: (input: string) => UnionPromise<string | undefined>
    /** TODO: Allows for any item to be used as opposed to the default. */
    // This is quite a bit more involved than just continuing to add more options, though it is the preferred way
    // itemFactory?: (input: string, validationMessage?: string) => DataQuickPickItem<T>
}

type QuickPickButtons<T> = PrompterButtons<T, QuickPickPrompter<T>>
/**
 * Options to configure the `QuickPick` beyond `vscode.QuickPickOptions`.
 *
 * @note Use transform() instead of onDidSelectItem().
 *
 */
export type ExtendedQuickPickOptions<T> = Omit<
    vscode.QuickPickOptions,
    // TODO: remove 'canPickMany' from Omit and implement/test functionality with multiple QuickPick items.
    'canPickMany' | 'placeHolder' | 'onDidSelectItem'
> & {
    title?: string
    value?: string
    step?: number
    placeholder?: string
    totalSteps?: number
    buttons?: QuickPickButtons<T>
    /**
     * Setting this option will enable 'filter-box input' mode, allowing the user to create their own QuickInputItem
     * using the filter box as input.
     */
    filterBoxInput?: FilterBoxInput<T>
    /** Used to sort QuickPick items after loading new ones */
    compare?: (a: DataQuickPickItem<T>, b: DataQuickPickItem<T>) => number
    /** [NOT IMPLEMENTED] Item to show while items are loading */
    loadingItem?: DataQuickPickItem<T>
    /** Item to show if no items were loaded. Can also be a string to replace the default label. */
    noItemsFoundItem?: string | DataQuickPickItem<T>
    /** Item to show if there was an error loading items. Can also be a string to replace the default label. */
    errorItem?: string | DataQuickPickItem<T> | ((err: Error) => string | DataQuickPickItem<T>)
    // TODO: just make this apart of 'createQuickPick', maybe allow non-cached too?
    /** Function uses to load items instead of initializing the quick pick */
    itemLoader?: ItemLoader<T>
}

/** See {@link ExtendedQuickPickOptions.noItemsFoundItem noItemsFoundItem} for setting a different item */
const DEFAULT_NO_ITEMS_ITEM = {
    label: localize('AWS.picker.dynamic.noItemsFound.label', '[No items found]'),
    detail: localize('AWS.picker.dynamic.noItemsFound.detail', 'Click here to go back'),
    alwaysShow: true,
    data: WIZARD_BACK,
}

/** See {@link ExtendedQuickPickOptions.errorItem errorItem} for setting a different error item */
const DEFAULT_ERROR_ITEM = {
    // TODO: add icon, check for C9
    label: localize('AWS.picker.dynamic.error.label', '[Error loading items]'),
    alwaysShow: true,
    data: WIZARD_BACK,
}

export const DEFAULT_QUICKPICK_OPTIONS: ExtendedQuickPickOptions<any> = {
    ignoreFocusOut: true,
    noItemsFoundItem: DEFAULT_NO_ITEMS_ITEM,
    errorItem: DEFAULT_ERROR_ITEM,
}

type QuickPickData<T> = PromptResult<T> | (() => Promise<PromptResult<T>>)
type LabelQuickPickItem<T> = vscode.QuickPickItem & { label: T }

interface BaseItem<T> {
    /** Invalid selections cannot be picked and instead are intended for information or hooks for `onClick`. */
    invalidSelection?: boolean
    /** Callback fired when the item is selected. This does not affect control flow and is intended for side-effects. */
    onClick?: () => any | Promise<any>
    /**
     * Stops the QuickPick from estimating how many steps an item would add in a Wizard flow.
     *
     * By default this is true except for when the `data` field is a function.
     */
    skipEstimate?: boolean
    /**
     * Marks an item as 'recently used' (i.e. from a prior prompt), applying text to its description field when shown.
     */
    recentlyUsed?: boolean
}

type Item<T = any> = vscode.QuickPickItem &
    BaseItem<T> &
    (
        | {
              data: QuickPickData<T>
          }
        | {
              data?: any
              invalidSelection: true
          }
    )

/**
 * Attaches additional information as `data` to a QuickPickItem. Alternatively, `data` can be a function that
 * returns a Promise, evaluated after the user selects the item.
 */
export type DataQuickPickItem<T> = Item<T>
export type DataQuickPick<T> = Omit<vscode.QuickPick<DataQuickPickItem<T>>, 'buttons'> & {
    buttons: QuickPickButtons<T>
}

export const CUSTOM_USER_INPUT = Symbol()

function isDataQuickPickItem(obj: any): obj is DataQuickPickItem<any> {
    return typeof obj === 'object' && typeof (obj as vscode.QuickPickItem).label === 'string' && 'data' in obj
}

type AsyncIterableOpt<T> = AsyncIterable<T | T[]>
/**
 * QuickPick prompts currently support loading:
 * * A plain array of items
 * * A promise for an array of items
 * * An AsyncIterable that generates an array of items every iteration
 * * A {@link PartialCachedFunction} that returns one of the above
 */
type ItemLoadTypes<T> =
    | Promise<DataQuickPickItem<T>[]>
    | DataQuickPickItem<T>[]
    | AsyncIterableOpt<DataQuickPickItem<T>>
type ItemLoader<T> = PartialCachedFunction<() => ItemLoadTypes<T>, true, Record<string, any>>

/**
 * Creates a UI element that presents a list of items. Information that should be returned when the user selects an
 * item must be placed in the `data` property of each item. If only the `label` is desired, use
 * {@link createLabelQuickPick} instead.
 *
 * @param items An array or a Promise for items.
 * @param options Customizes the QuickPick and QuickPickPrompter.
 * @returns A {@link QuickPickPrompter}. This can be used directly with the `prompt` method or can be fed into a Wizard.
 */
export function createQuickPick<T>(
    items: ItemLoadTypes<T>,
    options?: ExtendedQuickPickOptions<T>
): QuickPickPrompter<T> {
    const picker = vscode.window.createQuickPick<DataQuickPickItem<T>>() as DataQuickPick<T>
    const mergedOptions = { ...DEFAULT_QUICKPICK_OPTIONS, ...options }
    applyPrimitives(picker, mergedOptions)
    picker.buttons = mergedOptions.buttons ?? []

    const prompter =
        mergedOptions.filterBoxInput !== undefined
            ? new FilterBoxQuickPickPrompter<T>(
                  picker,
                  mergedOptions as RequireKey<typeof mergedOptions, 'filterBoxInput'>
              )
            : new QuickPickPrompter<T>(picker, mergedOptions)

    prompter.loadItems(items)

    // TODO: should this just be left up to the caller?
    if (mergedOptions.itemLoader && !mergedOptions.buttons?.some(b => b.tooltip === 'Refresh')) {
        prompter.addButton(createRefreshButton(), function () {
            this.refreshItems()
        })
    }

    return prompter
}

// Note: the generic type used in `createLabelQuickPick` is needed to infer the correct type when using string
// literal types. Otherwise the narrowness of the type would be lost.
/** Creates a QuickPick from normal QuickPickItems, using the `label` as the return value. */
export function createLabelQuickPick<T extends string>(
    items: LabelQuickPickItem<T>[] | Promise<LabelQuickPickItem<T>[]>,
    options?: ExtendedQuickPickOptions<T>
): QuickPickPrompter<T> {
    if (items instanceof Promise) {
        return createQuickPick(
            items.then(items => items.map(item => ({ data: item.label, ...item }))),
            options
        )
    }
    return createQuickPick(
        items.map(item => ({ data: item.label, ...item })),
        options
    )
}

function acceptItems<T>(picker: DataQuickPick<T>, resolve: (items: DataQuickPickItem<T>[]) => void): void {
    if (picker.selectedItems.length === 0) {
        return
    }

    picker.selectedItems.forEach(item => (item.onClick !== undefined ? item.onClick() : undefined))

    if (picker.selectedItems.some(item => item.invalidSelection)) {
        return
    }

    // TODO: if data is a function => Promise then we need to invoke the function and wait for the Promise
    // to resolve, then we can return (and we should set the picker to be busy/disabled)

    resolve(Array.from(picker.selectedItems))
}

function castDatumToItems<T>(...datum: T[]): DataQuickPickItem<T>[] {
    return datum.map(data => ({ label: '', data }))
}

/**
 * Atempts to recover a QuickPick item given an already processed response.
 *
 * This is generally required when the prompter is being used in a 'saved' state, such as when updating forms
 * that were already submitted. Failed recoveries simply return undefined, which means that the recent item
 * is unknown (generally the default in this case is to select the first item).
 */
function recoverItemFromData<T>(data: T, items: readonly DataQuickPickItem<T>[]): DataQuickPickItem<T> | undefined {
    const stringified = JSON.stringify(data)

    return items.find(item => {
        if (typeof item.data === 'object') {
            return stringified === JSON.stringify(item.data)
        }

        return typeof item.data === 'function' ? false : data === item.data
    })
}

/**
 * 'item' options can potentially just be a string to replace the label, so resolve it into an item from a base.
 */
function resolveItemOption<T>(base: DataQuickPickItem<T>, item: string | DataQuickPickItem<T>): DataQuickPickItem<T> {
    if (typeof item === 'string') {
        return { ...base, label: item }
    }
    return item
}

function hashItem(item: DataQuickPickItem<any>): string {
    return `${item.label}:${item.description ?? ''}:${item.detail ?? ''}`
}

/** Appends text to an item description, wrapping in parentheses if the description is not empty. */
const applyDescriptionSuffix = (suffix: string) => (item: Item) => {
    if (!item.recentlyUsed) {
        return item
    }

    const description = `${item.description ?? ''}${item.description ? ` (${suffix})` : suffix}`
    return { ...item, description }
}

/**
 * Sets up hooks for estimating QuickPick steps. Returns a disposable to remove the events.
 */
async function applyStepEstimator<T, R = T>(
    picker: DataQuickPick<T>,
    estimator: StepEstimator<T | R>,
    transform?: (data: PromptResult<T>) => PromptResult<R>
): Promise<vscode.Disposable> {
    const estimates: Record<string, number> = {}

    const estimate = (item: DataQuickPickItem<T>) => {
        if (item.skipEstimate || item.invalidSelection) {
            return 0
        }
        const hash = hashItem(item)

        if (estimates[hash] !== undefined) {
            return estimates[hash]
        } else if (item.data instanceof Function) {
            // `skipEstimate` is true by default for functions
            if (item.skipEstimate !== false) {
                return (estimates[hash] = 0)
            }

            return item
                .data()
                .then(data => transform?.(data) ?? data)
                .then(result => estimator(result))
                .then(estimate => (estimates[hash] = estimate))
        } else {
            return (estimates[hash] = estimator(transform?.(item.data) ?? item.data))
        }
    }

    const { step, totalSteps } = picker
    if (!step || !totalSteps) {
        return { dispose: () => {} }
    }

    const disposable = picker.onDidChangeActive(async active => {
        if (active.length === 0) {
            return
        }
        const estimation = Math.max(...(await Promise.all(active.map(estimate))))
        picker.totalSteps = totalSteps + estimation
    })

    // We await the first promise before returning to guarantee that there is no 'stutter'
    // when showing the current/total step numbers. For long-running estimates then could
    // potentially stall the flow.
    if (picker.items.length > 0) {
        picker.totalSteps = totalSteps + (await estimate(picker.items[0]))
    }

    return disposable
}

/**
 * A generic UI element that presents a list of items for the user to select. Wraps around {@link vscode.QuickPick QuickPick}.
 */
export class QuickPickPrompter<T> extends QuickInputPrompter<T> {
    protected _lastPicked?: DataQuickPickItem<T>
    protected _itemLoader?: (() => ItemLoadTypes<T>) & { clearCache?: () => void }
    // Placeholder can be any 'ephemeral' item such as `noItemsItem` or `errorItem` that should be removed on refresh
    private isShowingPlaceholder?: boolean
    private _recentItem: T | DataQuickPickItem<T> | undefined

    /**
     * Sets the "last selected/accepted" item or input, making it the active selection.
     * See {@link BaseItem.recentlyUsed recentlyUsed} for flagging items used in a previous flow.
     */
    public set recentItem(response: T | DataQuickPickItem<T> | undefined) {
        this._recentItem = response
        this.matchRecentItem()
    }

    public get recentItem() {
        return this._lastPicked
    }

    constructor(
        public readonly quickPick: DataQuickPick<T>,
        protected readonly options: ExtendedQuickPickOptions<T> = {}
    ) {
        super(quickPick)
    }

    public transform<R>(callback: Transform<T, R>): QuickPickPrompter<R> {
        return super.transform(callback) as QuickPickPrompter<R>
    }

    public clearCache(): void {
        this._itemLoader?.clearCache?.()
    }

    public async refreshItems(): Promise<void> {
        if (this._itemLoader !== undefined) {
            this._itemLoader.clearCache?.()
            this.clearItems()
            await this.loadItems(this._itemLoader())
        }
    }

    public clearItems(): void {
        this.quickPick.items = []
        this.isShowingPlaceholder = false
    }

    /**
     * Attempts to set the currently selected items. If no matching items were found, the first item in
     * the QuickPick is selected.
     *
     * @param items The items to look for
     */
    public selectItems(...items: DataQuickPickItem<T>[]): void {
        const selected = new Set(items.map(item => item.label))

        // Note: activeItems refer to the 'highlighted' items in a QuickPick, while selectedItems only
        // changes _after_ the user hits enter or clicks something. For a multi-select QuickPick,
        // selectedItems will change as options are clicked (and not when accepting).
        this.quickPick.activeItems = this.quickPick.items.filter(item => selected.has(item.label))

        if (this.quickPick.activeItems.length === 0) {
            this.quickPick.activeItems = [this.quickPick.items[0]]
        }
    }

    private setCache(cache: Record<string, any>): void {
        const itemLoader = this.options?.itemLoader
        if (itemLoader === undefined) {
            return
        }

        this._itemLoader = itemLoader(cache)
        this.loadItems(this._itemLoader())
    }

    /**
     * Appends items to the current array, keeping track of the previous selection
     */
    private appendItems(items: DataQuickPickItem<T>[]): void {
        const picker = this.quickPick
        const recent = picker.activeItems
        const sort = (a: Item, b: Item) =>
            a.recentlyUsed ? -1 : b.recentlyUsed ? 1 : this.options.compare?.(a, b) ?? 0

        picker.items = picker.items.concat(items.map(applyDescriptionSuffix(recentlyUsed))).sort(sort)
        this.selectItems(...recent)
    }

    /** Adds a placeholder item if the picker is empty and if there are no more updates pending. */
    private checkEmpty(pendingUpdate: boolean = this.pendingUpdates > 0): void {
        if (this.quickPick.items.length === 0 && !pendingUpdate) {
            this.isShowingPlaceholder = true
            this.quickPick.items =
                this.options.noItemsFoundItem !== undefined
                    ? [resolveItemOption(DEFAULT_NO_ITEMS_ITEM, this.options.noItemsFoundItem)]
                    : []
            this.selectItems()
        }
    }

    protected addErrorItem(error: Error): void {
        const errorOption = this.options.errorItem
        if (!errorOption) {
            return
        }

        this.isShowingPlaceholder = true // TODO: this will force a refresh if items are loaded after the error occurs
        const evalOption = typeof errorOption === 'function' ? errorOption(error) : errorOption
        const resolvedItem = resolveItemOption(DEFAULT_ERROR_ITEM, evalOption)
        resolvedItem.detail ??= error.message
        this.appendItems([resolvedItem])
    }

    protected async loadFromAsyncIterable(items: AsyncIterableOpt<DataQuickPickItem<T>>): Promise<void> {
        // Technically AsyncIterators have three types: one for yield, one for return, and one
        // for parameters to `next`. We only care about the first two, where the yield type will
        // always be the same as the AsyncIterable type variable, and the second will potentially
        // be undefined
        const iterator = items[Symbol.asyncIterator]() as AsyncIterator<
            DataQuickPickItem<T> | DataQuickPickItem<T>[],
            DataQuickPickItem<T> | DataQuickPickItem<T>[] | undefined
        >
        // Any caching of the iterator should be handled externally; we will not keep track of
        // where we left off when the prompt has been hidden
        let hidden = false
        const checkHidden = this.quickPick.onDidHide(() => (hidden = true))
        try {
            while (!hidden) {
                const { value, done } = await iterator.next()
                if (value) {
                    this.appendItems(Array.isArray(value) ? value : [value])
                }
                if (done) {
                    break
                }
            }
        } finally {
            checkHidden.dispose()
        }
    }

    // TODO: add options to this to clear items _before_ loading them
    /**
     * Loads items into the QuickPick. Can accept an array or a Promise for items. Promises will cause the
     * QuickPick to become 'busy', disabling user-input until loading is finished. Items are appended to
     * the current set of items. Use `clearItems` prior to loading if this behavior is not desired. The
     * previously selected item will remain selected if it still exists after loading.
     *
     * @param items DataQuickPickItems or a promise for said items
     * @param disableInput Disables the prompter until the items have been loaded, only relevant for async loads (default: false)
     * @returns A promise that is resolved when loading has finished
     */
    public async loadItems(items: ItemLoadTypes<T>, disableInput?: boolean): Promise<void> {
        // This code block assumes that callers never try to load items in parallel
        // For now this okay since we don't have any pickers that require that capability

        if (this.isShowingPlaceholder) {
            this.clearItems()
        }

        const handleError = (err: Error) => {
            getLogger().verbose('QuickPickPrompter: loading items failed: %s', (err as Error).message)
            this.addErrorItem(err)
        }

        if (Array.isArray(items)) {
            this.appendItems(items)
            this.checkEmpty()
        } else {
            const loader =
                items instanceof Promise ? items.then(this.appendItems.bind(this)) : this.loadFromAsyncIterable(items)
            const withHandlers = loader.catch(handleError).finally(() => this.checkEmpty(this.pendingUpdates > 1))
            await this.addBusyUpdate(withHandlers, disableInput)
        }
    }

    /**
     * Clears the prompter, then loads new items. Will automatically attempt to select the previously
     * selected items. This is a combination of {@link QuickPickPrompter.loadItems loadItems} and
     * {@link QuickPickPrompter.clearItems clearItems}.
     *
     * @param items Items to load
     * @returns Promise that is resolved upon completion
     */
    public async clearAndLoadItems(items: ItemLoadTypes<T>): Promise<void> {
        const previousSelected = [...this.quickPick.activeItems]
        this.clearItems()
        await this.loadItems(items)
        this.selectItems(...previousSelected)
    }

    private async applyConfig(config: PrompterConfiguration<T>): Promise<void> {
        if (config.steps) {
            this.setSteps(config.steps.current, config.steps.total)
        }
        if (config.cache) {
            this.setCache(config.cache)
        }
        if (config.stepEstimator) {
            await applyStepEstimator(this.quickPick, config.stepEstimator, this.applyTransforms.bind(this))
        }
    }

    /** Selects `recentItem` if it exists. */
    private matchRecentItem(): void {
        const match = this.quickPick.items.find(this.isRecentItem.bind(this))
        if (match) {
            this.selectItems(match)
            this._recentItem = undefined
        } else if (this.quickPick.activeItems.length === 0) {
            this.selectItems()
        }
    }

    protected async promptUser(config: PrompterConfiguration<T>): Promise<PromptResult<T>> {
        await this.applyConfig(config)
        // Need to do this on the next loop, there's a *tiny* amount of flicker but it's tolerable
        setTimeout(this.matchRecentItem.bind(this))

        const picker = this.quickPick
        const choices = await new Promise<DataQuickPickItem<T>[]>(resolve => {
            const cast = (result: PromptResult<T>) => resolve(castDatumToItems(result))
            this.disposables.push(
                picker.onDidAccept(() => acceptItems(picker, resolve)),
                picker.onDidHide(() => resolve(castDatumToItems(WIZARD_EXIT))),
                picker.onDidTriggerButton(button => this.handleButton(button, cast))
            )
            this.show()
        })

        vscode.Disposable.from(...this.disposables).dispose()

        this._lastPicked = choices[0]
        const result = choices[0].data

        return result instanceof Function ? await result() : result
    }

    /**
     * Determines if the item matches the one set by `recentItem`.
     */
    protected isRecentItem(item: Item): boolean {
        // TODO: figure out how to recover from implicit responses
        if (this._recentItem === undefined) {
            return false
        } else if (!isDataQuickPickItem(this._recentItem)) {
            const recovered = recoverItemFromData(this._recentItem, this.quickPick.items)
            return item.label === recovered?.label
        }

        return item.label === this._recentItem.label
    }
}

/**
 * Allows the prompter to accept the QuickPick filter box as input, shown as a QuickPickItem.
 *
 * It is recommended to use `createQuickPick` instead of instantiating this class in isolation.
 *
 * @param label The label of the QuickPickItem that shows the user's input
 * @param transform Required when the expected type is not a string, transforming the input into the expected type or a control signal.
 */
export class FilterBoxQuickPickPrompter<T> extends QuickPickPrompter<T> {
    private readonly settings: FilterBoxInput<T>

    public override set recentItem(response: T | DataQuickPickItem<T> | undefined) {
        if (this.isUserInput(response)) {
            this.quickPick.value = response.description ?? ''
        } else {
            super.recentItem = response
        }
    }

    public override get recentItem(): DataQuickPickItem<T> | undefined {
        return this._lastPicked
    }

    constructor(quickPick: DataQuickPick<T>, options: RequireKey<ExtendedQuickPickOptions<T>, 'filterBoxInput'>) {
        super(quickPick, options)
        this.settings = options.filterBoxInput
        this.transform(selection => {
            if ((selection as T | typeof CUSTOM_USER_INPUT) === CUSTOM_USER_INPUT) {
                return this.settings.transform(quickPick.value) ?? selection
            }
            return selection
        })
        this.disposables.push(this.addFilterBoxInput())
    }

    // TODO: this hook can be generalized to a per-item basis rather than a prompter as a whole
    private addFilterBoxInput(): vscode.Disposable {
        const DEBOUNCE_TIME = 250
        const picker = this.quickPick as DataQuickPick<T | symbol>
        const validator = (input: string) =>
            this.settings.validator !== undefined ? this.settings.validator(input) : undefined
        const { label } = this.settings
        let timer: NodeJS.Timeout
        let pendingValidation: Promise<string | undefined> | undefined
        let pendingValue: string | undefined

        const createItem = (detail: string = '', invalidSelection: boolean = false) => {
            return {
                label,
                description: picker.value,
                alwaysShow: true,
                data: CUSTOM_USER_INPUT,
                invalidSelection,
                detail,
            } as DataQuickPickItem<T | symbol>
        }

        const update = (value: string = '') => {
            const items = picker.items.filter(item => item.data !== CUSTOM_USER_INPUT)
            clearTimeout(timer)

            if (value !== '') {
                const validate = pendingValidation ?? validator(value)
                if (validate instanceof Promise) {
                    pendingValidation = validate
                    pendingValue ??= value
                    timer = setTimeout(() => {
                        this.addBusyUpdate(
                            validate.then(result => {
                                const validatedValue = pendingValue
                                pendingValidation = pendingValue = undefined
                                if (validatedValue !== picker.value) {
                                    // stale validation
                                    update(picker.value)
                                    return
                                }
                                const inputItem = createItem(result, !!result)
                                picker.items = [inputItem, ...items]
                            })
                        )
                    }, DEBOUNCE_TIME)
                }
                const inputItem = createItem(validate instanceof Promise ? 'Checking...' : validate, !!validate)
                picker.items = [inputItem, ...items]
            } else {
                picker.items = items
            }
        }

        const disposable = picker.onDidChangeValue(update)
        update(picker.value)
        return disposable
    }

    private isUserInput(picked: any): picked is DataQuickPickItem<symbol> {
        return picked !== undefined && picked.data === CUSTOM_USER_INPUT
    }
}
