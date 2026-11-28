import { PackageEditorProvider } from './packageEditor';

// The same read-only page as the package preview, for key and signature text
// files: .pem, .key and .asc. Those are text that people edit, so unlike the
// package types this editor is registered with priority "option": the file
// still opens as text by default, and "Reopen Editor With..." offers this page,
// which says what the file holds and how it is protected, without showing a
// key. A separate view type is what lets the two priorities differ.
export class KeyFileEditorProvider extends PackageEditorProvider {
  public static readonly keyFileViewType = 'markcopy.keyFilePreview';
  protected override readonly viewType: string = KeyFileEditorProvider.keyFileViewType;
  protected override readonly noun = 'Key or signature file';
  protected override readonly promise =
    'Reading it says what the file holds and how it is protected. A key is never shown, no password is asked for, and nothing is decrypted.';
}
