import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Uri, commands } from "vscode";
import { Config, config_defaults, Utils } from './utils';
import { resolve } from 'dns';

const defaults = new config_defaults();

export interface MapInfo {
    sourceFile: string;
    items: string[];
};

declare global {
    interface String {
        trimStart(): string;
        trimEnd(): string;
    }
}

String.prototype.trimStart = function () {
    if (this.length == 0)
        return this;
    let c = ' ';
    var i = 0;
    for (; this.charAt(i) == c && i < this.length; i++);
    return this.substring(i);
}

String.prototype.trimEnd = function () {
    return this.replace(/ +$/, "");
}


export class FavoritesTreeProvider implements vscode.TreeDataProvider<MapItem> {

    private _onDidChangeTreeData: vscode.EventEmitter<MapItem | undefined> = new vscode.EventEmitter<MapItem | undefined>();
    readonly onDidChangeTreeData: vscode.Event<MapItem | undefined> = this._onDidChangeTreeData.event;

    public Items: MapItem[];

    constructor(private aggregateItems: () => MapInfo) {
        vscode.window.onDidChangeActiveTextEditor(editor => {
            MapItem.sortDirection = null;
            this._onDidChangeTreeData.fire();
        });
        vscode.workspace.onDidSaveTextDocument(e => {
            this._onDidChangeTreeData.fire();
        })
    }

    refresh(): void {
        try {
            this._onDidChangeTreeData.fire();
        } catch (error) {

        }
    }

    getTreeItem(element: MapItem): vscode.TreeItem {
        return element;
    }

    getParent?(element: MapItem): Thenable<MapItem> {
        return new Promise(resolve => {
            resolve(element.parent);
        });
    }

    getChildren(element?: MapItem): Thenable<MapItem[]> {
        return new Promise(resolve => {
            if (element) {
                let items = element.children;
                items.forEach(x => x.updateState());
                resolve(items);
                // resolve([]);
            } else {
                let items = this.getScriptItems()
                items.forEach(x => x.updateState());
                resolve(items);
            }
        });
    }

    public revealNodeOf(treeView: vscode.TreeView<MapItem>, lineNumber: number): void {
        treeView.reveal(this.getItemOf(lineNumber), { select: true, focus: false, expand: true })
    }

    public getItemOf(lineNumber: number): MapItem {

        let allItems: MapItem[] = [];
        for (let index = 0; index < this.Items.length; index++) {
            let item = this.Items[index];
            allItems.push(item);
            item.aggregateNestedChildren(allItems);
        }

        allItems = allItems.sort(MapItem.compareByLineNumber);

        let result: MapItem;

        if (allItems.length > 0)
            result = allItems[0];

        for (let index = 0; index < allItems.length; index++) {
            const element = allItems[index];

            if (element.lineNumber > lineNumber)
                break;

            result = element;
        }
        return result;
    }

    private getScriptItems(): MapItem[] {
        let nodes = [];

        // let refsNode = new MapItem('References', vscode.TreeItemCollapsibleState.Collapsed, 0, null, 'assembly_group');
        // nodes.push(refsNode);

        let info = this.aggregateItems();

        if (info == null || info.items.length == 0)
            return nodes;

        this.Items = FavoritesTreeProvider.parseScriptItems(info.items, info.sourceFile);
        return this.Items;
    }

    public static parseScriptItems(items: string[], sourceFile: string): MapItem[] {

        let nodes = [];
        let prev_node: MapItem = null;

        // https://github.com/Microsoft/vscode/issues/34130: TreeDataProvider: allow selecting a TreeItem without affecting its collapsibleState
        // https://github.com/patrys/vscode-code-outline/issues/24: Is it possible to disable expand/collapse on click
        // Until above items are fixed need to go with the plain text.
        let plainTextMode = vscode.workspace.getConfiguration("codemap").get('textMode', defaults.get('textMode'));
        let max_nesting_level = vscode.workspace.getConfiguration("codemap").get('maxNestingLevel', defaults.get('maxNestingLevel'));

        // default is empty (non-white space) character U+00A0; to avoid trimming by treeview renderer
        let levelUnitChar = vscode.workspace.getConfiguration("codemap").get('textModeLevelPrefix', defaults.get('textModeLevelPrefix'));

        let levelUnit = null;
        let map: { [index: number]: MapItem; } = {};

        items.forEach(item => {

            if (item != '') {
                let source_file = sourceFile;
                let tokens = item.split('|');
                let lineNumber = 0;
                let icon = 'document';

                let title: string = item;

                let nesting_level = item.length - item.trimStart().length;

                if (nesting_level != 0) {
                    if (!levelUnit)
                        levelUnit = nesting_level;
                    nesting_level = nesting_level / levelUnit;
                }

                if (tokens.length > 1) {
                    try {
                        title = tokens[0];
                        lineNumber = Number(tokens[1]) - 1;
                        icon = tokens[2];
                    } catch (error) {
                    }
                }
                else
                    source_file = null;

                if (nesting_level > max_nesting_level)
                    return;

                // the normal spaces are collapsed by the tree item renderer
                let non_whitespace_empty_char = levelUnitChar;

                if (!plainTextMode)
                    title = title.trimStart();

                let on_click_command = 'codemap.navigate_to';
                if (lineNumber == -1)
                    on_click_command = "";

                let textModeExpanded = vscode.workspace.getConfiguration("codemap").get('textModeExpanded', defaults.get('textModeExpanded'));

                title = title.replace('%pipe%', '|');

                let node = new MapItem(
                    title,
                    textModeExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
                    nesting_level,
                    {
                        command: on_click_command,
                        title: '',
                        // tooltip: file,
                        arguments: [source_file, lineNumber],
                    },
                    source_file + '|' + lineNumber,
                    lineNumber
                );

                if (plainTextMode) {
                    node.collapsibleState = vscode.TreeItemCollapsibleState.None;
                    node.label = non_whitespace_empty_char.repeat(nesting_level) + title;
                    nodes.push(node);
                }
                else {
                    if (nesting_level == 0) {
                        nodes.push(node);
                    }
                    else {
                        let parent = map[node.nesting_level - 1];
                        if (!parent) {
                            for (let key in map) {
                                parent = map[key];
                            }
                        }
                        parent.addChildItem(node);
                        node.parent = parent;
                    }
                }

                if (icon.startsWith("path:")) {

                    node.iconPath = {
                        light: icon.replace("path:", "").replace("{theme}", "light"),
                        dark: icon.replace("path:", "").replace("{theme}", "dark")
                    };
                }
                else {
                    let iconName = icon + ".svg";

                    node.iconPath = {
                        light: path.join(__filename, '..', '..', '..', 'resources', 'light', iconName),
                        dark: path.join(__filename, '..', '..', '..', 'resources', 'dark', iconName)
                    };
                }

                map[node.nesting_level] = node;
            }
        });

        let sortingEnabled = Config.get('sortingEnabled');
        if (sortingEnabled && !plainTextMode) {
            nodes.sort(MapItem.compareByTitle);
        }

        return nodes;
    }
}


export enum SortDirection {
    ByLocation,
    Decs,
    Asc
}

export class MapItem extends vscode.TreeItem {

    constructor(
        public readonly title: string,
        public readonly state: vscode.TreeItemCollapsibleState,
        public readonly nesting_level: number,
        public readonly command?: vscode.Command,
        public readonly context?: string,
        public readonly lineNumber?: number) {
        super(title, state);
    }

    public static sortDirection: SortDirection;

    public children: MapItem[] = [];
    public sortedByFilePositionChildren: MapItem[] = [];

    public parent: MapItem;
    // iconPath = {
    // 	light: path.join(__filename, '..', '..', '..', 'resources', 'light', 'document.svg'),
    // 	dark: path.join(__filename, '..', '..', '..', 'resources', 'dark', 'document.svg')
    // };
    public updateState(): void {
        if (this.children.length == 0)
            this.collapsibleState = vscode.TreeItemCollapsibleState.None;
    }

    public addChildItem(item: MapItem) {
        this.children.push(item);

        let sortingEnabled = Config.get('sortingEnabled');
        if (sortingEnabled) {
            // not very efficient to do it on every child added but OK as a starting point
            this.children = this.children.sort(MapItem.compareByTitle);
        }
    }

    public aggregateNestedChildren(result: MapItem[]): void {
        for (let index = 0; index < this.children.length; index++) {
            var element = this.children[index];
            result.push(element);
            element.aggregateNestedChildren(result);
        }
    }

    public static compareByLineNumber(n1: MapItem, n2: MapItem): number {
        if (n1.lineNumber > n2.lineNumber)
            return 1;

        if (n1.lineNumber < n2.lineNumber)
            return -1;

        return 0;
    }

    public static compareByTitle(n1: MapItem, n2: MapItem): number {

        if (MapItem.sortDirection == null || MapItem.sortDirection == SortDirection.Asc) {
            return MapItem.compareByTitleAsc(n1, n2);
        }
        else if (MapItem.sortDirection == SortDirection.Decs) {
            return MapItem.compareByTitleAsc(n2, n1);
        }

    }

    public static compareByTitleAsc(n1: MapItem, n2: MapItem): number {
        if (n1.title.toUpperCase() > n2.title.toUpperCase())
            return 1;

        if (n1.title.toUpperCase() < n2.title.toUpperCase())
            return -1;

        return 0;
    }

    contextValue = 'file';
}