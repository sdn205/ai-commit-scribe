export class GitExtensionNotFoundError extends Error {
    constructor() {
        super('Git extension not found. Please make sure it is installed and enabled.');
        this.name = 'GitExtensionNotFoundError';
    }
}

export class NoRepositoriesFoundError extends Error {
    constructor() {
        super('No Git repositories found in the current workspace.');
        this.name = 'NoRepositoriesFoundError';
    }
}

export class NoChangesDetectedError extends Error {
    constructor(message: string = 'No changes detected.') {
        super(message);
        this.name = 'NoChangesDetectedError';
    }
}

export class NoRepositorySelectedError extends Error {
    constructor() {
        super('No repository selected. Operation cancelled.');
        this.name = 'NoRepositorySelectedError';
    }
}