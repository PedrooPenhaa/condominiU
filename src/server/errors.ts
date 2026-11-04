export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(422, 'dados_invalidos', message);
export const unauthorized = (message = 'Entre com seu e-mail e senha para continuar.') => new HttpError(401, 'nao_autenticado', message);
export const forbidden = (message = 'Seu perfil não tem acesso a esta ação.') => new HttpError(403, 'sem_permissao', message);
export const notFound = (message = 'Registro não encontrado.') => new HttpError(404, 'nao_encontrado', message);
export const conflict = (message: string) => new HttpError(409, 'conflito', message);
