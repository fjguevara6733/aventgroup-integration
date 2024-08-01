import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import {
  arventGetTransactionsCredit,
  DoRequestDto,
} from 'src/common/dto/create-arvent-group.dto';
import { BindRequestInterface } from 'src/common/dto/create-arvent-group.interface.';
import { CoinsFiat, ConceptBind } from 'src/common/enum';
import { EntityManager } from 'typeorm';
import * as https from 'https';
import axios, { AxiosRequestConfig } from 'axios';
import { readFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ArventGroupService {
  private urlBind =
    process.env.environment === 'dev'
      ? process.env.URL_BIND
      : process.env.URL_BIND_PROD;
  private httpsAgent: https.Agent;
  private token: string;
  private timeTokenExpirate: Date;
  private USERNAME_BIND =
    process.env.environment === 'dev'
      ? process.env.USERNAME_BIND
      : process.env.USERNAME_BIND_PROD;
  private PASSWORD_BIND =
    process.env.environment === 'dev'
      ? process.env.PASSWORD_BIND
      : process.env.PASSWORD_BIND_PROD;
  private idBank = process.env.BANK_ID_BIND;
  private accountId =
    process.env.environment === 'dev'
      ? process.env.ACCOUNT_ID_BIND
      : process.env.ACCOUNT_ID_BIND_PROD;
  private idView = process.env.VIEW_ID_BIND;
  private clientCertificate = process.env.CLIENT_CERTIFICATE;
  private clientKey = process.env.CLIENT_KEY;
  private datos = [
    {
      email: 'sv@arventgroup.com',
      id: 311,
      cvu: '0000058100000000034579',
    },
    {
      email: 'hola@finpact.org',
      id: 256,
      cvu: '0000058100000000010919',
    },
    {
      email: 'sebastian.vigliola@gmail.com',
      id: 258,
      cvu: '0000058100000000011264',
    },
    {
      email: 'marint',
      id: 1,
      cvu: '0000058100000000034531',
    },
  ];

  constructor(
    @InjectEntityManager('chronos')
    private readonly chronosEntityManager: EntityManager,
    @InjectEntityManager('arventGroup')
    private readonly arventGroupEntityManager: EntityManager,
  ) {}
  async balances(email) {
    const emails = this.datos.find(
      (e) => e.email.toLocaleLowerCase() === email.toLocaleLowerCase(),
    );

    if (emails === undefined) return 'Email no asociado a ninguna cuenta';
    const query = `SELECT balance,'ARS' FROM cvu_accounts where cvu=${Number(emails.cvu)}`;
    const result = await this.chronosEntityManager
      .query(query)
      .then((response) => response)
      .catch((error) => error);

    return result;
  }

  async getTransactions(req) {
    const { hasta, desde, email } = req;
    const emails = this.datos.find(
      (e) => e.email.toLocaleLowerCase() === email.toLocaleLowerCase(),
    );

    if (!this.getFormattedDate(hasta, desde))
      return 'Error en el rango de fechas';
    if (emails === undefined) return 'Email no asociado a ninguna cuenta';

    const query = `SELECT b.datetime,
      c.transaction_id_2,c.counterparty_id,c.counterparty_account_address,
      c.counterparty_name,c.origin_debit_cvu,
      c.origin_debit_cuit,  b.transaction_type,
      c.transaction_status,c.transaction_amount
      FROM cvu_account_transactions a, transactions b,
      bind_cvu_accounts_transactions c
      where
      b.account_transaction_id=a.cvu_account_transaction_id
      and a.bind_transaction_id=c.id  and
      a.cvu_account_id=${emails.id} and
      date_format(datetime, '%Y%m%d') between
      '${desde.replace('-', '').replace('-', '')}' and '${hasta.replace('-', '').replace('-', '')}'`;

    const result = await this.chronosEntityManager
      .query(query)
      .then((response) => response)
      .catch((error) => error);

    return result;
  }

  private getFormattedDate(desde, hasta): boolean {
    const fechaDesde = new Date(desde);
    const fechaHasta = new Date(hasta);

    // Calcula la diferencia en milisegundos entre las dos fechas
    const diferenciaMilisegundos = Math.abs(
      fechaHasta.getTime() - fechaDesde.getTime(),
    );

    // Calcula la diferencia en días dividiendo por la cantidad de milisegundos en un día (86400000)
    const diferenciaDias = Math.ceil(diferenciaMilisegundos / 86400000);

    return diferenciaDias <= 3;
  }

  async requestLogin() {
    try {
      const data = {
        username: this.USERNAME_BIND,
        password: this.PASSWORD_BIND,
      };

      const config = {
        method: 'post',
        url: this.urlBind + '/login/jwt',
        data,
      };

      if (this.clientCertificate && this.clientKey) {
        this.httpsAgent = new https.Agent({
          cert: readFileSync(this.clientCertificate),
          key: readFileSync(this.clientKey),
        });

        config['httpsAgent'] = this.httpsAgent;
      }

      const response = await axios(config);
      const timeExpire = new Date(
        new Date().getTime() + response.data.expires_in * 1000,
      );

      this.timeTokenExpirate = timeExpire;

      this.token = response.data.token;

      return response.data.token;
    } catch (error) {
      console.log(error?.response);
      throw new Error(error?.response?.data?.message);
    }
  }

  async checkTokenAndReconnect(expirationDate: Date) {
    const currentTime = new Date().getTime();
    const expirationTime = expirationDate.getTime();
    const oneMinuteInMillis = 60 * 1000;

    if (expirationTime - currentTime <= oneMinuteInMillis) {
      await this.requestLogin();
    }
  }

  async getToken() {
    if (!this.token) {
      return await this.requestLogin();
    }
    await this.checkTokenAndReconnect(this.timeTokenExpirate);
    return this.token;
  }

  async doTransaction(body: DoRequestDto) {
    try {
      const { destinationCbu, amount, email } = body;
      const emails = this.datos.find(
        (e) => e.email.toLocaleLowerCase() === email.toLocaleLowerCase(),
      );
      const params: BindRequestInterface = {
        origin_id: uuidv4().substring(0, 14).replace(/-/g, '0'),
        origin_debit: {
          cvu: emails.cvu,
        },
        value: {
          currency: CoinsFiat.ARS,
          amount: Number(amount).toFixed(2),
        },
        to: {
          cbu: destinationCbu,
        },
        concept: ConceptBind.VAR,
        description: 'Pago Alfred',
      };

      const headers = {
        Authorization: `JWT ${await this.getToken()}`,
      };
      const url = `${this.urlBind}/banks/${this.idBank}/accounts/${this.accountId}/${this.idView}/transaction-request-types/TRANSFER-CVU/transaction-requests`;
      const config: AxiosRequestConfig = {
        method: 'POST',
        url,
        data: params,
        headers,
        httpsAgent: this.httpsAgent,
      };

      const response = await axios(config);
      const data = response.data;

      const dataString = JSON.stringify(data);
      await this.arventGroupEntityManager
        .query(
          `INSERT INTO transactions (idTransaction,response, status, email, dateTransaction)
          VALUES ('${params.origin_id}', '${dataString}', '${data.status}', '${body.email}', ${new Date()})`,
        )
        .then((response) => response)
        .catch((error) => error);

      return data;
    } catch (error) {
      console.log(error.response.data);
      throw new Error(error?.response?.data?.message);
    }
  }

  async transactionReport() {
    const data = await this.arventGroupEntityManager.query(
      'SELECT * FROM transactions',
    );
    const response = data.map((e) => {
      return {
        id: e.idTransaction,
        status: e.status,
        emailOriginDebit: e.email,
        responseBank: JSON.parse(e.response),
      };
    });
    return response;
  }

  async updateStatusTransactions() {
    const data = await this.arventGroupEntityManager.query(
      'SELECT * FROM transactions WHERE status = "IN_PROGRESS"',
    );

    for (const transaction of data) {
      const response = JSON.parse(transaction.response);
      const { transaction_ids } = response;
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: `https://api.chronospay.io/alfred-wallet/v1/transaction/get-transaction/${transaction_ids[0]}`,
        httpsAgent: this.httpsAgent,
      };
      const responseAxios = await axios(config);
      const data = responseAxios.data;
      const dataResponse = data.data;
      await this.arventGroupEntityManager
        .query(
          `UPDATE transactions SET status = '${dataResponse.status}', response = '${JSON.stringify(dataResponse)}' WHERE id = ${transaction.id}`,
        )
        .then((response) => response)
        .catch((error) => error);
    }
    return true;
  }

  async creditTransactions(payload: arventGetTransactionsCredit) {
    const headers = {
      Authorization: `JWT ${await this.getToken()}`,
      ...payload,
    };
    const url = `${this.urlBind}/banks/${this.idBank}/accounts/${this.accountId}/${this.idView}/transactions`;
    const config: AxiosRequestConfig = {
      method: 'GET',
      url,
      headers,
      httpsAgent: this.httpsAgent,
    };

    const response = await axios(config)
      .then((response) => response.data)
      .catch((error) => {
        console.log(error.response.data);
        throw new Error(error?.response?.data?.message);
      });
    console.log('response', response);
    const accountCredits = [];
    const data = [];
    for (const transaction of response) {
      const { this_account } = transaction;
      const { account_routing } = this_account;
      const searchCVU = accountCredits.find(
        (e) => e.cvu === account_routing.address,
      );
      if (searchCVU) {
        data.push(transaction);
      }
    }
    for (const transaction of data) {
      const { details, this_account } = transaction;
      const { value } = details;
      const { account_routing } = this_account;
      const index = accountCredits.findIndex(
        (e) => e.cvu === account_routing.address,
      );
      if (index === -1) {
        accountCredits.push({
          cvu: account_routing.address,
          amount: value.amount,
          count: 1,
        });
      } else {
        accountCredits[index].amount =
          Number(accountCredits[index].amount) + Number(value.amount);
        accountCredits[index].count = Number(accountCredits[index].count) + 1;
      }
    }
    return accountCredits;
    // const data = [
    //   {
    //     id: 'NSBT-1-58-685741-65-1-20240801-10-10-762-1',
    //     counterparty: {
    //       id: '27372520855',
    //       name: 'SOSA CECILIA FERNANDA',
    //       id_type: 'CUIT_CUIL',
    //       bank_routing: {
    //         scheme: 'UNAVAILABLE',
    //         address: '',
    //       },
    //       account_routing: {
    //         scheme: 'CVU',
    //         address: '0000013000032212666895',
    //       },
    //     },
    //     details: {
    //       type: 'TRANSFERENCIAS_RECIBIDAS',
    //       description: 'Transferencia Credito',
    //       posted: '2024-08-01T00:00:00Z',
    //       completed: '2024-08-01T14:20:51Z',
    //       value: {
    //         currency: 'ARS',
    //         amount: 9786.8,
    //       },
    //       motive: 'VAR',
    //       reference_number: 'LOEJWV9J05YP5OQM2QMD0G',
    //       new_balance: {
    //         currency: 'ARS',
    //         amount: 77859937.88,
    //       },
    //     },
    //     metadata: {
    //       tags: [],
    //     },
    //     this_account: {
    //       id: '20-1-685741-1-5',
    //       kind: '20',
    //       bank_routing: {
    //         scheme: 'NAME',
    //         address: 'BANCO INDUSTRIAL S.A.',
    //         code: '322',
    //       },
    //       account_routing: {
    //         scheme: 'CVU',
    //         address: '0000058100000000034531',
    //       },
    //     },
    //   },
    //   {
    //     id: 'NSBT-1-55-685741-65-1-20240801-10-10-8939-1',
    //     counterparty: {
    //       id: '27945021042',
    //       name: 'HERRERA JORDAN MARCIA BRISSETT',
    //       id_type: 'CUIT_CUIL',
    //       bank_routing: {
    //         scheme: 'UNAVAILABLE',
    //         address: '',
    //       },
    //       account_routing: {
    //         scheme: 'CVU',
    //         address: '0000013000032159277185',
    //       },
    //     },
    //     details: {
    //       type: 'TRANSFERENCIAS_RECIBIDAS',
    //       description: 'Transferencia Credito',
    //       posted: '2024-08-01T00:00:00Z',
    //       completed: '2024-08-01T13:52:55Z',
    //       value: {
    //         currency: 'ARS',
    //         amount: 5936.27,
    //       },
    //       motive: 'VAR',
    //       reference_number: 'LOEJWV9J05YQO0RR2QMD0G',
    //       new_balance: {
    //         currency: 'ARS',
    //         amount: 79292878.85,
    //       },
    //     },
    //     metadata: {
    //       tags: [],
    //     },
    //     this_account: {
    //       id: '20-1-685741-1-5',
    //       kind: '20',
    //       bank_routing: {
    //         scheme: 'NAME',
    //         address: 'BANCO INDUSTRIAL S.A.',
    //         code: '322',
    //       },
    //       account_routing: {
    //         scheme: 'CVU',
    //         address: '0000058100000000034531',
    //       },
    //     },
    //   },
    //   {
    //     id: 'NSBT-1-50-685741-65-1-20240801-10-10-7224-1',
    //     counterparty: {
    //       id: '27372520855',
    //       name: 'SOSA CECILIA FERNANDA',
    //       id_type: 'CUIT_CUIL',
    //       bank_routing: {
    //         scheme: 'UNAVAILABLE',
    //         address: '',
    //       },
    //       account_routing: {
    //         scheme: 'CVU',
    //         address: '0000013000032212666895',
    //       },
    //     },
    //     details: {
    //       type: 'TRANSFERENCIAS_RECIBIDAS',
    //       description: 'Transferencia Credito',
    //       posted: '2024-08-01T00:00:00Z',
    //       completed: '2024-08-01T12:51:14Z',
    //       value: {
    //         currency: 'ARS',
    //         amount: 12703.27,
    //       },
    //       motive: 'VAR',
    //       reference_number: 'LMORZP90K7J6YRJY9EGJ46',
    //       new_balance: {
    //         currency: 'ARS',
    //         amount: 83025546.55,
    //       },
    //     },
    //     metadata: {
    //       tags: [],
    //     },
    //     this_account: {
    //       id: '20-1-685741-1-5',
    //       kind: '20',
    //       bank_routing: {
    //         scheme: 'NAME',
    //         address: 'BANCO INDUSTRIAL S.A.',
    //         code: '322',
    //       },
    //       account_routing: {
    //         scheme: 'CVU',
    //         address: '0000058100000000034531',
    //       },
    //     },
    //   },
    // ];
  }
}
