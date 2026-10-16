interface CommitInput { value: string }

const normalize = (value: string): string => value.replace(/\r\n?/g, '\n');

// SCM 会异步回显程序写入的内容，且可能统一换行符。
export class CommitInputWriter {
    private readonly ownValues = new Set<string>();
    private edited = false;

    constructor(private readonly input: CommitInput) {
        this.ownValues.add(normalize(input.value));
    }

    get userEdited(): boolean {
        if (!this.ownValues.has(normalize(this.input.value))) {this.edited = true;}
        return this.edited;
    }

    write(text: string): boolean {
        if (this.userEdited) {return false;}
        // 记录所有已写入值，避免乱序回显被误判为用户编辑。
        const value = normalize(text);
        this.ownValues.add(value);
        this.input.value = value;
        return true;
    }
}
