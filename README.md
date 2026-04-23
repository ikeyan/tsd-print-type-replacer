<!-- deno-fmt-ignore-file -->
# tsd-print-type-replacer

[tsd](https://github.com/tsdjs/tsd) の `printType` が出力した型を、ソースコード中の対応する `{} as T` に貼り付け、役目を終えた `printType(...)` 呼び出しを取り除くDeno製CLIユーティリティ。

tsdの `printType` の出力:

```
⚠  270:0  Type for expression {} as ObjectMerge<{'0': number; '1': number}, {0: string}> is: { 0: string; '1': number; }
```

を読んで、ソースの `{} as ObjectMerge<…>` を `{} as { 0: string; '1': number; }` に自動で書き換えます。

## 必要環境

- [Deno](https://deno.com/) 2.x

## 使い方

ソースコードに `printType` を書く:

```ts
import { expectType, printType } from 'tsd';

printType({} as ObjectMerge<{'0': number; '1': number}, {0: string}>);
expectType<{0: string; '1': number}>(
  {} as ObjectMerge<{'0': number; '1': number}, {0: string}>);
```

tsdを実行し、出力をこのツールにパイプする:

```sh
tsd 2>&1 | deno run --allow-read --allow-write=. tsd-print-type-replacer.ts .
```

> **Note**
> tsdは診断を **stderr** に書き出すので、`2>&1` でstdoutに合流させてからpipeしてください。

書き換え後:

```ts
import { expectType, printType } from 'tsd';

expectType<{0: string; '1': number}>(
  {} as { 0: string; '1': number; });
```

source の `printType(...)` 自体は削除され、別の箇所で見つかった `{} as T` の `T` 部分だけが tsd の報告型 (`{ 0: string; '1': number; }`) に置換されます。`{}` などの左辺はそのまま残ります。

## CLI

```
tsd 2>&1 | deno run --allow-read --allow-write=. tsd-print-type-replacer.ts [options] [target-dir]
```

### 引数

| 引数 | 説明 |
| --- | --- |
| `target-dir` | tsdの出力に含まれるファイルパスを解決する基準ディレクトリ (デフォルト: `.`) |

### オプション

| オプション | 説明 |
| --- | --- |
| `-n`, `--next-statement-only` | `printType` 呼び出しを含むstatementの **次のstatement** だけを置換対象にする。未指定時はファイル全体を対象に、同じ式をすべて置換する |
| `--dry-run` | 書き換えずに変更予定のみを表示 |
| `-h`, `--help` | ヘルプを表示 |

### 権限

| 権限 | 用途 |
| --- | --- |
| `--allow-read` | ソースファイルの読み込み |
| `--allow-write=.` | ソースファイルの書き戻し (`=.` でカレント配下に制限推奨) |

## 動作仕様

### 置換対象

tsdの診断 `Type for expression EXPR is: TYPE` のうち、**EXPR が型アサーション (`X as T`) の形**のときだけ処理します。識別子や関数呼び出しなど `as` を含まない式はスキップしwarningを出します。

source の `printType(X as T)` 自体は置換対象に含めません。source 以外で一致した `X as T` が 1 件以上あったときだけ、それらの `T` を `TYPE` に置換し、source の `printType(...)` を削除します。外部に一致がなければ warning を出し、source は残します。

置換は `T` の範囲のみが対象で、`X` (`{}` など) には触れません。

### `--next-statement-only`

例えば次のパターンで:

```ts
printType({} as ObjectMerge<{'0': number; '1': number}, {0: string}>);
expectType<{0: string; '1': number}>(
  {} as ObjectMerge<{'0': number; '1': number}, {0: string}>);
// ここの `{} as ObjectMerge<…>` は置換したくない
const x = {} as ObjectMerge<{'0': number; '1': number}, {0: string}>;
```

`--next-statement-only` を付けると `printType(…)` の直後のstatement (ここでは `expectType<…>(…)`) のみが置換対象になり、それ以降の同じ式 (`const x = …`) は触られません。直後のstatement内で 1 件以上置換が起きた場合は、source の `printType(…)` が削除されます。

指定がない場合は、そのファイル中でマッチした `{} as T` を **すべて** 置換します。

### 空白・コメント無視のマッチング

tsdの `argumentExpression` は `node.getText()` の生ソース。一方でソース側には後から空白やコメントを差し込んでいる可能性があります。例えば:

- tsdの出力: `{} as M<{a: 1}, {a: 2}>`
- ソース: `{}   as   M<{a: 1}, /* inline */ {a: 2}>`

このツールはTypeScriptのScannerで両方をトークン列化し、trivia (空白・コメント) を除いた `{kind, text}` の列として比較するため、上のようなケースでも同じ式として一致させます。

## テスト

```sh
deno test --allow-read --allow-write --allow-env --allow-run
```

含まれるテストケース:

- source `printType(...)` を削除しつつ後続の一致箇所だけを置換すること
- `--next-statement-only` で次のstatementだけが置換されること
- ソース側に空白やインラインコメントがあっても一致すること
- 一致箇所が source しかない場合は warning になること
- comma 演算子や通常の式位置で source 削除ルールが正しく適用されること
- `as` を含まない式はスキップされること

## 実装メモ

- tsdの出力は `eslint-formatter-pretty` でフォーマットされており、pipe時 (非TTY) は chalk がANSIコードを落とします。`` Type for expression `EXPR` is: `TYPE` `` のバックティックも、formatter内部の `chalk.bold(…)` への置換で剥がれます。本ツールは剥がれたプレーンテキストをパースする前提です。
- マッチング用のトークナイザはTypeScriptの `ts.createScanner(…, /* skipTrivia */ true)` を直接使っており、フルASTの代わりに軽量に動きます。
- 置換位置のためだけに `ts.createSourceFile(…, /* setParentNodes */ true)` でパースしています。
