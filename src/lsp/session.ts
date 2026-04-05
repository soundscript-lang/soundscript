export interface OpenDocument {
  languageId: string;
  text: string;
  uri: string;
  version: number;
}

export class SessionState {
  readonly #documents = new Map<string, OpenDocument>();
  #revision = 0;

  get(uri: string): OpenDocument | undefined {
    return this.#documents.get(uri);
  }

  getAll(): readonly OpenDocument[] {
    return [...this.#documents.values()];
  }

  revision(): number {
    return this.#revision;
  }

  open(document: OpenDocument): void {
    this.#documents.set(document.uri, document);
    this.#revision += 1;
  }

  close(uri: string): void {
    if (this.#documents.delete(uri)) {
      this.#revision += 1;
    }
  }

  update(uri: string, version: number, text: string): void {
    const existing = this.#documents.get(uri);
    if (!existing) {
      return;
    }

    this.#documents.set(uri, {
      ...existing,
      text,
      version,
    });
    this.#revision += 1;
  }
}
