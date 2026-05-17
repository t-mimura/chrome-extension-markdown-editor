# プライバシーポリシー / Privacy Policy

**Markdown Editor（Chrome 拡張機能）**
最終更新日 / Last updated: 2026-05-17

---

## 日本語

### 収集する情報

本拡張機能は、開発者のサーバーへ**いかなる個人情報も送信しません**。

ドキュメントおよび画像データは以下のいずれかにのみ保存されます。

- **お使いのブラウザのローカルストレージ**（IndexedDB / chrome.storage.local）
- **お客様自身の Google Drive**（同期機能を有効にした場合のみ）

### 使用するアクセス許可と目的

| アクセス許可 | 目的 |
|-------------|------|
| `storage` | ドキュメント・画像・設定をブラウザ内に保存するため |
| `tabs` | 拡張機能アイコンのクリックで新しいタブを開くため |
| `identity` | Google アカウントの認証（Drive 同期機能を使用する場合のみ）|
| `https://www.googleapis.com/auth/drive.file` | 本拡張機能が作成したファイルのみを Google Drive で読み書きするため |

`drive.file` スコープは、**本拡張機能が自ら作成したファイル**にのみアクセスできる最小限の権限です。お客様の Drive 内の他のファイルへはアクセスしません。

### Google Drive の利用について

Google Drive 同期を有効にした場合、ドキュメントと画像データはお客様自身の Google Drive 内の「Markdown Editor」フォルダに保存されます。このデータは開発者を含む第三者からアクセスできません。

Google のプライバシーポリシーについては [https://policies.google.com/privacy](https://policies.google.com/privacy) をご参照ください。

### データの共有

収集したデータを第三者と共有することは一切ありません。

### トラッキング・解析

本拡張機能は、アクセス解析・クラッシュレポート・使用状況の追跡を一切行いません。

### お問い合わせ

プライバシーに関するご質問は以下までご連絡ください。

**chrome-extension-markdown-editor-support@googlegroups.com**

---

## English

### Information We Collect

This extension does **not** transmit any personal information to the developer's servers.

Your documents and images are stored exclusively in:

- **Your browser's local storage** (IndexedDB / chrome.storage.local)
- **Your own Google Drive** (only when the sync feature is enabled)

### Permissions and Their Purpose

| Permission | Purpose |
|-----------|---------|
| `storage` | To save documents, images, and settings locally in your browser |
| `tabs` | To open a new tab when the extension icon is clicked |
| `identity` | Google account authentication (only when using Google Drive sync) |
| `https://www.googleapis.com/auth/drive.file` | To read and write files in Google Drive that were created by this extension only |

The `drive.file` scope provides the minimum required access — it only allows access to files **created by this extension**. No other files in your Google Drive can be accessed.

### Google Drive Usage

When Google Drive sync is enabled, your documents and images are stored in a "Markdown Editor" folder within your own Google Drive account. This data is not accessible to the developer or any third party.

For Google's privacy policy, please visit [https://policies.google.com/privacy](https://policies.google.com/privacy).

### Data Sharing

We do not share any data with third parties.

### Tracking and Analytics

This extension does not perform any analytics, crash reporting, or usage tracking.

### Contact

For privacy-related inquiries, please contact:

**chrome-extension-markdown-editor-support@googlegroups.com**
