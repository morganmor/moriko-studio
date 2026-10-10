export interface {{Name}}Props {
  title?: string;
}

export function {{Name}}(props: {{Name}}Props) {
  const { title } = props;
  return (
    <section className="{{name_kebab}}">
      <h2>{title ?? '{{Name}}'}</h2>
    </section>
  );
}
